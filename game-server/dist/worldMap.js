"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadWorldMapFromDisk = loadWorldMapFromDisk;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const DEFAULT_ROOM_NAME = 'SaiPoke Realm';
function defaultRoomName(index) {
    return index === 0 ? DEFAULT_ROOM_NAME : `Map ${index + 1}`;
}
function loadWorldMapFromDisk() {
    const mapPath = path_1.default.join(__dirname, '../../gather-clone/frontend/utils/defaultmap.json');
    const raw = fs_1.default.readFileSync(mapPath, 'utf8');
    const data = JSON.parse(raw);
    data.rooms = data.rooms.map((room, index) => ({
        ...room,
        id: room.id?.trim() || `map-${index}`,
        name: room.name?.trim() || defaultRoomName(index),
    }));
    return data;
}
