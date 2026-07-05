"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.worldMapFileHash = worldMapFileHash;
exports.worldMapFileVersion = worldMapFileVersion;
exports.loadWorldMapFromDisk = loadWorldMapFromDisk;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const DEFAULT_ROOM_NAME = 'Pokequest-cards';
function defaultRoomName(index) {
    return index === 0 ? DEFAULT_ROOM_NAME : `Map ${index + 1}`;
}
function resolveMapPath() {
    const candidates = [
        path_1.default.join(__dirname, '../data/defaultmap.json'),
        path_1.default.join(__dirname, '../../data/defaultmap.json'),
        path_1.default.join(__dirname, '../../gather-clone/frontend/utils/defaultmap.json'),
    ];
    for (const mapPath of candidates) {
        if (fs_1.default.existsSync(mapPath)) {
            return mapPath;
        }
    }
    throw new Error(`World map not found. Tried: ${candidates.join(', ')}`);
}
function worldMapFileHash() {
    const mapPath = resolveMapPath();
    const raw = fs_1.default.readFileSync(mapPath);
    return crypto_1.default.createHash('md5').update(raw).digest('hex');
}
function worldMapFileVersion() {
    const mapPath = resolveMapPath();
    return String(Math.floor(fs_1.default.statSync(mapPath).mtimeMs / 1000));
}
function loadWorldMapFromDisk() {
    const mapPath = resolveMapPath();
    const raw = fs_1.default.readFileSync(mapPath, 'utf8');
    const data = JSON.parse(raw);
    data.rooms = data.rooms.map((room, index) => ({
        ...room,
        id: room.id?.trim() || `map-${index}`,
        name: room.name?.trim() || defaultRoomName(index),
    }));
    return data;
}
