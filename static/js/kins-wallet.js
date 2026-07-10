(function () {
    let solanaModulesPromise = null
    let kinsWalletPending = false
    const PAYMENT_WALLET_KEY = "pokequest_payment_wallet"

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    function shortWallet(address) {
        const a = String(address || "")
        if (a.length < 10) return a || ""
        return `${a.slice(0, 4)}…${a.slice(-4)}`
    }

    function getSavedPaymentWallet() {
        try {
            return localStorage.getItem(PAYMENT_WALLET_KEY) || sessionStorage.getItem(PAYMENT_WALLET_KEY) || ""
        } catch {
            return ""
        }
    }

    function savePaymentWallet(address) {
        const addr = String(address || "").trim()
        if (!addr) return
        try {
            localStorage.setItem(PAYMENT_WALLET_KEY, addr)
            sessionStorage.setItem(PAYMENT_WALLET_KEY, addr)
            sessionStorage.setItem("pokequest_wallet_address", addr)
        } catch {
            /* ignore */
        }
        window.dispatchEvent(new CustomEvent("pokequest:payment-wallet", { detail: { address: addr } }))
    }

    function clearPaymentWallet() {
        try {
            localStorage.removeItem(PAYMENT_WALLET_KEY)
            sessionStorage.removeItem(PAYMENT_WALLET_KEY)
        } catch {
            /* ignore */
        }
        window.dispatchEvent(new CustomEvent("pokequest:payment-wallet", { detail: { address: "" } }))
    }

    function setKinsWalletPending(active, message) {
        kinsWalletPending = Boolean(active)
        document.body.classList.toggle("kins-wallet-pending", kinsWalletPending)

        const overlay = document.getElementById("kins-wallet-pending")
        const label = document.getElementById("kins-wallet-pending-label")
        if (overlay) overlay.classList.toggle("hidden", !kinsWalletPending)
        if (label && message) label.textContent = message

        document.querySelectorAll("[data-kins-buy]").forEach((el) => {
            el.disabled = kinsWalletPending
            el.setAttribute("aria-disabled", kinsWalletPending ? "true" : "false")
        })

        if (!kinsWalletPending && typeof window.SaiPokeKins?.refreshBuyButtons === "function") {
            window.SaiPokeKins.refreshBuyButtons()
        }
    }

    function bytesToBase58(bytes) {
        const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
        if (window.bs58?.encode) {
            return window.bs58.encode(arr)
        }
        throw new Error("Wallet payment helpers still loading — try again.")
    }

    function normalizeSignature(signature) {
        if (!signature) return ""
        if (typeof signature === "string") return signature
        return bytesToBase58(signature)
    }

    async function loadSolanaModules() {
        if (!solanaModulesPromise) {
            solanaModulesPromise = Promise.all([
                import("https://esm.sh/@solana/web3.js@1.98.0"),
                import("https://esm.sh/@solana/spl-token@0.4.13"),
                import("https://esm.sh/bs58@6.0.0"),
            ]).then(([web3, spl, bs58]) => {
                window.bs58 = bs58.default || bs58
                return { web3, spl }
            })
        }
        return solanaModulesPromise
    }

    function getWalletProvider() {
        if (window.phantom?.solana?.isPhantom) return window.phantom.solana
        if (window.solflare?.isSolflare || window.solflare?.publicKey) return window.solflare
        return null
    }

    async function ensureWalletConnected() {
        let provider = getWalletProvider()
        if (!provider) {
            throw new Error("Install Phantom or Solflare, then refresh this page.")
        }
        if (!provider.publicKey) {
            const result = await provider.connect()
            const addr = String(result?.publicKey || provider.publicKey || "")
            if (!addr) throw new Error("Wallet did not return an address.")
            savePaymentWallet(addr)
            return addr
        }
        const addr = String(provider.publicKey.toString())
        savePaymentWallet(addr)
        return addr
    }

    async function fetchKinsConfig() {
        const response = await fetch("/api/kins/config")
        const data = await response.json()
        if (!response.ok || !data.success) {
            throw new Error(data.error || "Could not load $POKEQUEST config.")
        }
        return data
    }

    async function fetchLatestBlockhash(config) {
        const response = await fetch("/api/kins/blockhash")
        const data = await response.json()
        if (response.ok && data.success && data.blockhash) {
            return {
                blockhash: data.blockhash,
                lastValidBlockHeight: data.lastValidBlockHeight,
            }
        }

        const rpcUrl = config?.rpcUrl
        if (!rpcUrl) {
            throw new Error(data.error || "Could not fetch a recent Solana blockhash.")
        }

        const { web3 } = await loadSolanaModules()
        const { Connection } = web3
        const connection = new Connection(rpcUrl, "confirmed")
        try {
            return await connection.getLatestBlockhash("confirmed")
        } catch (error) {
            throw new Error(
                error?.message || data.error || "Could not fetch a recent Solana blockhash.",
            )
        }
    }

    function resolveTransferPlan(transfer, config) {
        const amountKins = Math.trunc(Number(transfer?.amountKins))
        if (!Number.isFinite(amountKins) || amountKins <= 0) {
            throw new Error("Invalid $POKEQUEST payment amount.")
        }

        const decimals = Number.isFinite(transfer?.decimals)
            ? Number(transfer.decimals)
            : Number.isFinite(config?.mintDecimals)
              ? Number(config.mintDecimals)
              : 6

        let rawAmount
        if (transfer?.rawAmount != null && String(transfer.rawAmount).trim() !== "") {
            rawAmount = BigInt(String(transfer.rawAmount).trim())
        } else {
            rawAmount = BigInt(amountKins) * (10n ** BigInt(decimals))
        }

        const expectedRaw = BigInt(amountKins) * (10n ** BigInt(decimals))
        if (rawAmount !== expectedRaw) {
            throw new Error("Payment amount mismatch — refresh and try again.")
        }

        const createTreasuryAtaIfNeeded =
            transfer?.createTreasuryAtaIfNeeded === true ||
            (transfer?.createTreasuryAtaIfNeeded !== false &&
                config?.createTreasuryAtaIfNeeded === true)

        return {
            amountKins,
            rawAmount,
            decimals,
            tokenProgram: transfer?.tokenProgram || config?.tokenProgram,
            mint: transfer?.mint || config?.mint,
            treasuryWallet: transfer?.treasuryWallet || config?.treasuryWallet,
            createTreasuryAtaIfNeeded,
        }
    }

    async function sendKinsTransfer(transfer) {
        await ensureWalletConnected()
        const provider = getWalletProvider()
        if (!provider?.publicKey) {
            throw new Error("Connect Phantom or Solflare first.")
        }

        const config = await fetchKinsConfig()
        const plan = resolveTransferPlan(transfer, config)
        if (!plan.tokenProgram || !plan.mint || !plan.treasuryWallet) {
            throw new Error("Missing $POKEQUEST transfer configuration.")
        }

        const { web3, spl } = await loadSolanaModules()
        const { PublicKey, Transaction, Connection } = web3
        const {
            getAssociatedTokenAddress,
            createTransferCheckedInstruction,
            createAssociatedTokenAccountIdempotentInstruction,
        } = spl

        const tokenProgramId = new PublicKey(plan.tokenProgram)
        const mint = new PublicKey(plan.mint)
        const treasury = new PublicKey(plan.treasuryWallet)
        const owner = new PublicKey(provider.publicKey.toString())

        const ownerAta = await getAssociatedTokenAddress(
            mint,
            owner,
            false,
            tokenProgramId,
        )
        const treasuryAta = await getAssociatedTokenAddress(
            mint,
            treasury,
            false,
            tokenProgramId,
        )

        const connection = config.rpcUrl ? new Connection(config.rpcUrl, "confirmed") : null
        let createTreasuryAta = plan.createTreasuryAtaIfNeeded

        if (connection) {
            const treasuryInfo = await connection.getAccountInfo(treasuryAta)
            createTreasuryAta = !treasuryInfo

            const ownerInfo = await connection.getAccountInfo(ownerAta)
            if (!ownerInfo) {
                throw new Error(
                    `No $POKEQUEST token account found in this wallet. You need at least ${plan.amountKins} $POKEQUEST.`,
                )
            }

            const balance = await connection.getTokenAccountBalance(ownerAta)
            const walletAmount = Number(balance?.value?.uiAmountString || 0)
            if (walletAmount + 1e-9 < plan.amountKins) {
                throw new Error(
                    `Wallet balance is ${walletAmount} $POKEQUEST — need at least ${plan.amountKins}.`,
                )
            }
        }

        const { blockhash, lastValidBlockHeight } = await fetchLatestBlockhash(config)
        const transaction = new Transaction({
            feePayer: owner,
            blockhash,
            lastValidBlockHeight,
        })

        if (createTreasuryAta) {
            transaction.add(
                createAssociatedTokenAccountIdempotentInstruction(
                    owner,
                    treasuryAta,
                    treasury,
                    mint,
                    tokenProgramId,
                ),
            )
        }

        transaction.add(
            createTransferCheckedInstruction(
                ownerAta,
                mint,
                treasuryAta,
                owner,
                plan.rawAmount,
                plan.decimals,
                [],
                tokenProgramId,
            ),
        )

        const result = await provider.signAndSendTransaction(transaction)
        const signature = normalizeSignature(result?.signature || result)
        if (!signature) {
            throw new Error("Wallet did not return a transaction signature.")
        }
        return signature
    }

    async function confirmKinsPayment(paymentId, signature, authBody) {
        setKinsWalletPending(true, "Confirming on-chain payment…")
        for (let attempt = 0; attempt < 18; attempt += 1) {
            const response = await fetch("/api/kins/confirm", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(authBody({ paymentId, signature })),
            })
            const data = await response.json()
            if (response.ok && data.success) {
                return data
            }
            const message = data.error || "Payment not verified."
            if (!/not found yet|load transaction/i.test(message)) {
                throw new Error(message)
            }
            await sleep(2000)
        }
        throw new Error("Payment confirmation timed out. Check your wallet and retry.")
    }

    async function payKinsIntent(intentPath, intentBody, authBody) {
        if (kinsWalletPending) {
            throw new Error("A wallet payment is already in progress.")
        }

        setKinsWalletPending(true, "Connecting wallet…")
        try {
            const walletAddress = await ensureWalletConnected()
            setKinsWalletPending(true, "Preparing payment…")
            const intentResponse = await fetch(intentPath, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(authBody({ ...intentBody, walletAddress })),
            })
            const intent = await intentResponse.json()
            if (!intentResponse.ok || !intent.success) {
                throw new Error(intent.error || "Could not start $POKEQUEST payment.")
            }

            const transfer = intent.transfer || { amountKins: intent.amountKins }
            setKinsWalletPending(true, "Approve in your wallet…")
            const signature = await sendKinsTransfer(transfer)
            return await confirmKinsPayment(intent.paymentId, signature, (extra) =>
                authBody({ ...extra, walletAddress }),
            )
        } finally {
            setKinsWalletPending(false)
        }
    }

    async function getTokenUiBalance(walletAddress) {
        const address = String(walletAddress || "").trim()
        if (!address) return 0
        const config = await fetchKinsConfig()
        if (!config.rpcUrl || !config.mint) return 0
        const { web3 } = await loadSolanaModules()
        const { Connection, PublicKey } = web3
        const connection = new Connection(config.rpcUrl, "confirmed")
        const mint = new PublicKey(config.mint)
        const owner = new PublicKey(address)
        const tokenProgramId = config.tokenProgram
            ? new PublicKey(config.tokenProgram)
            : undefined
        try {
            const accounts = await connection.getParsedTokenAccountsByOwner(
                owner,
                tokenProgramId ? { mint, programId: tokenProgramId } : { mint },
            )
            let total = 0
            for (const item of accounts?.value || []) {
                const amount = item?.account?.data?.parsed?.info?.tokenAmount
                total += Number(amount?.uiAmount || 0)
            }
            return Math.floor(total + 1e-9)
        } catch {
            return 0
        }
    }

    window.KinsWallet = {
        fetchKinsConfig,
        sendKinsTransfer,
        confirmKinsPayment,
        payKinsIntent,
        getWalletProvider,
        ensureWalletConnected,
        getSavedPaymentWallet,
        savePaymentWallet,
        clearPaymentWallet,
        getTokenUiBalance,
        shortWallet,
        isPaymentPending: () => kinsWalletPending,
        setPaymentPending: setKinsWalletPending,
    }
})()
