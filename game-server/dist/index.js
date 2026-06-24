"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.io = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const socket_io_1 = require("socket.io");
const dotenv_1 = __importDefault(require("dotenv"));
const sockets_1 = require("./sockets");
const session_1 = require("./session");
const worldMap_1 = require("./worldMap");
for (const envPath of [
    path_1.default.join(__dirname, '../../../.env'),
    path_1.default.join(__dirname, '../../.env'),
]) {
    dotenv_1.default.config({ path: envPath });
}
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
app.use((0, cors_1.default)({
    origin: allowedOrigins,
    credentials: true,
}));
app.use(express_1.default.json());
const POKETAB_NOTIFY_SECRET = process.env.POKETAB_NOTIFY_SECRET || 'poketab-local-dev';
const io = new socket_io_1.Server(server, {
    cors: {
        origin: allowedOrigins,
        credentials: true,
    },
});
exports.io = io;
app.get('/health', (_req, res) => {
    const session = session_1.sessionManager.getSession(session_1.WORLD_ID);
    const players = session?.getPlayerCount() ?? 0;
    let mapHash = '';
    let mapVersion = '';
    try {
        mapHash = (0, worldMap_1.worldMapFileHash)();
        mapVersion = (0, worldMap_1.worldMapFileVersion)();
    }
    catch {
        mapHash = 'missing';
    }
    res.json({
        ok: true,
        players,
        maxPlayers: 50,
        world: 'SaiPoke Realm',
        worldId: session_1.WORLD_ID,
        rooms: session?.map_data?.rooms?.length ?? 1,
        worldMapHash: mapHash,
        worldMapVersion: mapVersion,
    });
});
app.get('/getPlayersInRoom', (req, res) => {
    const uid = req.query.uid;
    const roomIndex = Number(req.query.roomIndex);
    if (!uid) {
        return res.status(400).json({ message: 'Missing uid' });
    }
    if (Number.isNaN(roomIndex)) {
        return res.status(400).json({ message: 'Invalid room index' });
    }
    const session = session_1.sessionManager.getPlayerSession(uid);
    if (!session) {
        return res.status(400).json({ message: 'User not in game.' });
    }
    return res.json({ players: session.getPlayersInRoom(roomIndex) });
});
app.get('/getOnlinePlayers', (_req, res) => {
    const players = session_1.sessionManager.getAllOnlinePlayers().map((player) => ({
        uid: player.uid,
        username: player.username,
        skin: player.skin,
        room: player.room,
        x: player.x,
        y: player.y,
    }));
    return res.json({ players });
});
app.post('/internal/poketab-notify', (req, res) => {
    const { secret, targetUid, event, data } = req.body || {};
    if (secret !== POKETAB_NOTIFY_SECRET) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    if (!targetUid || !event) {
        return res.status(400).json({ ok: false, error: 'Missing targetUid or event' });
    }
    const socketId = session_1.sessionManager.getSocketIdForUid(String(targetUid));
    if (socketId) {
        io.to(socketId).emit('poketab', { event, data: data || {} });
    }
    return res.json({ ok: true, delivered: Boolean(socketId) });
});
const mapData = (0, worldMap_1.loadWorldMapFromDisk)();
session_1.sessionManager.createSession(session_1.WORLD_ID, mapData);
(0, sockets_1.sockets)(io);
const PORT = process.env.PORT || 3001;
server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Game server running on 0.0.0.0:${PORT}`);
});
