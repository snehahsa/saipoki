(function () {
    let solanaModulesPromise = null

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms))
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

    async function fetchKinsConfig() {
        const response = await fetch("/api/kins/config")
        const data = await response.json()
        if (!response.ok || !data.success) {
            throw new Error(data.error || "Could not load $KINS config.")
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
            throw new Error("Invalid $KINS payment amount.")
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

        return {
            amountKins,
            rawAmount,
            decimals,
            tokenProgram: transfer?.tokenProgram || config?.tokenProgram,
            mint: transfer?.mint || config?.mint,
            treasuryWallet: transfer?.treasuryWallet || config?.treasuryWallet,
        }
    }

    async function sendKinsTransfer(transfer) {
        const provider = getWalletProvider()
        if (!provider?.publicKey) {
            throw new Error("Connect Phantom or Solflare first.")
        }

        const config = await fetchKinsConfig()
        if (config.treasuryReady === false) {
            throw new Error(
                "Treasury $KINS account is not ready yet. Try again in a few minutes.",
            )
        }

        const plan = resolveTransferPlan(transfer, config)
        if (!plan.tokenProgram || !plan.mint || !plan.treasuryWallet) {
            throw new Error("Missing $KINS transfer configuration.")
        }

        const { web3, spl } = await loadSolanaModules()
        const { PublicKey, Transaction, Connection } = web3
        const { getAssociatedTokenAddress, createTransferCheckedInstruction } = spl

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
        if (connection) {
            const treasuryInfo = await connection.getAccountInfo(treasuryAta)
            if (!treasuryInfo) {
                throw new Error(
                    "Treasury $KINS account is not ready yet. Only token transfers are supported — try again shortly.",
                )
            }

            const ownerInfo = await connection.getAccountInfo(ownerAta)
            if (!ownerInfo) {
                throw new Error(
                    `No $KINS token account found in this wallet. You need at least ${plan.amountKins} $KINS.`,
                )
            }

            const balance = await connection.getTokenAccountBalance(ownerAta)
            const walletAmount = Number(balance?.value?.uiAmountString || 0)
            if (walletAmount + 1e-9 < plan.amountKins) {
                throw new Error(
                    `Wallet balance is ${walletAmount} $KINS — need at least ${plan.amountKins}.`,
                )
            }
        }

        const { blockhash, lastValidBlockHeight } = await fetchLatestBlockhash(config)
        const transaction = new Transaction({
            feePayer: owner,
            blockhash,
            lastValidBlockHeight,
        })

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
        const intentResponse = await fetch(intentPath, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(authBody(intentBody)),
        })
        const intent = await intentResponse.json()
        if (!intentResponse.ok || !intent.success) {
            throw new Error(intent.error || "Could not start $KINS payment.")
        }

        const transfer = intent.transfer || { amountKins: intent.amountKins }
        const signature = await sendKinsTransfer(transfer)
        return confirmKinsPayment(intent.paymentId, signature, authBody)
    }

    window.KinsWallet = {
        fetchKinsConfig,
        sendKinsTransfer,
        confirmKinsPayment,
        payKinsIntent,
        getWalletProvider,
    }
})()
