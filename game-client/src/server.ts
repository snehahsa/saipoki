import io, { Socket } from 'socket.io-client'
import signal from '@/utils/signal'

type ConnectionResponse = {
    success: boolean
    errorMessage: string
}

const CONNECT_TIMEOUT_MS = 30000

class Server {
    public socket: Socket = {} as Socket
    private connected: boolean = false
    private backendUrl: string = ''
    private uid: string = ''
    private connectionToken = 0

    public configure(backendUrl: string, uid: string) {
        this.backendUrl = backendUrl || window.location.origin
        this.uid = String(uid)
    }

    public disconnect() {
        this.connected = false
        if (!this.socket || typeof this.socket.disconnect !== 'function') {
            return
        }

        this.socket.removeAllListeners()
        this.socket.disconnect()
    }

    public async connect(username: string, skin: string, level: number = 1) {
        this.disconnect()
        const token = ++this.connectionToken

        this.socket = io(this.backendUrl, {
            transports: ['polling'],
            reconnection: false,
            autoConnect: false,
            query: {
                uid: this.uid,
            },
        })

        return new Promise<ConnectionResponse>((resolve) => {
            let settled = false

            const finish = (result: ConnectionResponse) => {
                if (settled || token !== this.connectionToken) return
                settled = true
                clearTimeout(timer)
                resolve(result)
            }

            const timer = setTimeout(() => {
                this.disconnect()
                finish({
                    success: false,
                    errorMessage: 'Connection timed out. Check your network and try again.',
                })
            }, CONNECT_TIMEOUT_MS)

            this.socket.connect()

            this.socket.once('connect', () => {
                this.connected = true
                this.socket.emit('joinGame', { username, skin, level: Math.max(1, Number(level) || 1) })
            })

            this.socket.once('joinedRealm', () => {
                this.socket.on('poketab', (payload) => {
                    signal.emit('poketab', payload)
                })
                finish({ success: true, errorMessage: '' })
            })

            this.socket.once('failedToJoinRoom', (reason: string) => {
                finish({ success: false, errorMessage: reason })
            })

            this.socket.once('connect_error', (err: Error) => {
                finish({ success: false, errorMessage: err.message })
            })

            this.socket.once('disconnect', () => {
                if (!settled) {
                    finish({
                        success: false,
                        errorMessage: 'Lost connection to the game server.',
                    })
                }
            })
        })
    }

    public async getPlayersInRoom(roomIndex: number) {
        const params = new URLSearchParams({
            roomIndex: String(roomIndex),
            uid: this.uid,
        })

        const response = await fetch(`${this.backendUrl}/getPlayersInRoom?${params}`)

        if (!response.ok) {
            return { data: null, error: { message: 'Failed to fetch players' } }
        }

        const data = await response.json()
        return { data, error: null }
    }
}

export const server = new Server()
