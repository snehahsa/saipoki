"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NewMessage = exports.ChangedSkin = exports.Teleport = exports.MovePlayer = exports.Disconnect = exports.JoinGame = void 0;
const zod_1 = require("zod");
exports.JoinGame = zod_1.z.object({
    username: zod_1.z.string().min(1).max(64),
    skin: zod_1.z.string().min(1).max(64),
    level: zod_1.z.number().int().min(1).max(9999).optional(),
});
exports.Disconnect = zod_1.z.any();
exports.MovePlayer = zod_1.z.object({
    x: zod_1.z.number(),
    y: zod_1.z.number(),
});
exports.Teleport = zod_1.z.object({
    x: zod_1.z.number(),
    y: zod_1.z.number(),
    roomIndex: zod_1.z.number(),
});
exports.ChangedSkin = zod_1.z.string();
exports.NewMessage = zod_1.z.string();
