const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// 中間件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../krunker-game')));

// 遊戲狀態管理
class GameServer {
    constructor() {
        this.rooms = new Map();
        this.players = new Map();
        this.maxPlayersPerRoom = 8;
        
        console.log('遊戲伺服器初始化完成');
    }
    
    createRoom(roomId, hostId) {
        const room = {
            id: roomId,
            hostId: hostId,
            players: new Map(),
            gameState: 'waiting', // waiting, playing, ended
            settings: {
                maxPlayers: this.maxPlayersPerRoom,
                gameMode: 'ffa', // ffa, tdm
                mapName: 'default',
                timeLimit: 300 // 5分鐘
            },
            gameData: {
                startTime: null,
                scores: new Map()
            }
        };
        
        this.rooms.set(roomId, room);
        console.log(`房間 ${roomId} 已創建`);
        return room;
    }
    
    joinRoom(roomId, playerId, playerData) {
        let room = this.rooms.get(roomId);
        
        // 如果房間不存在，創建新房間
        if (!room) {
            room = this.createRoom(roomId, playerId);
        }
        
        // 檢查房間是否已滿
        if (room.players.size >= room.settings.maxPlayers) {
            return { success: false, error: '房間已滿' };
        }
        
        // 添加玩家到房間
        const player = {
            id: playerId,
            ...playerData,
            position: { x: 0, y: 2, z: 0 },
            rotation: { x: 0, y: 0 },
            health: 100,
            score: { kills: 0, deaths: 0 },
            isAlive: true,
            lastUpdate: Date.now()
        };
        
        room.players.set(playerId, player);
        this.players.set(playerId, { roomId, socketId: playerData.socketId });
        
        console.log(`玩家 ${playerId} 加入房間 ${roomId}`);
        return { success: true, room, player };
    }
    
    leaveRoom(playerId) {
        const playerInfo = this.players.get(playerId);
        if (!playerInfo) return;
        
        const room = this.rooms.get(playerInfo.roomId);
        if (!room) return;
        
        room.players.delete(playerId);
        this.players.delete(playerId);
        
        // 如果房間空了，刪除房間
        if (room.players.size === 0) {
            this.rooms.delete(playerInfo.roomId);
            console.log(`房間 ${playerInfo.roomId} 已刪除（無玩家）`);
        } else if (room.hostId === playerId) {
            // 如果房主離開，選擇新房主
            const newHost = room.players.keys().next().value;
            room.hostId = newHost;
            console.log(`房間 ${playerInfo.roomId} 新房主: ${newHost}`);
        }
        
        console.log(`玩家 ${playerId} 離開房間 ${playerInfo.roomId}`);
        return playerInfo.roomId;
    }
    
    updatePlayer(playerId, updateData) {
        const playerInfo = this.players.get(playerId);
        if (!playerInfo) return null;
        
        const room = this.rooms.get(playerInfo.roomId);
        if (!room) return null;
        
        const player = room.players.get(playerId);
        if (!player) return null;
        
        // 更新玩家數據
        Object.assign(player, updateData, { lastUpdate: Date.now() });
        
        return { room, player };
    }
    
    handlePlayerShoot(playerId, shootData) {
        const playerInfo = this.players.get(playerId);
        if (!playerInfo) return null;
        
        const room = this.rooms.get(playerInfo.roomId);
        if (!room) return null;
        
        const shooter = room.players.get(playerId);
        if (!shooter || !shooter.isAlive) return null;
        
        // 廣播射擊事件
        return {
            roomId: playerInfo.roomId,
            shooterId: playerId,
            shootData: {
                origin: shootData.origin,
                direction: shootData.direction,
                timestamp: Date.now()
            }
        };
    }
    
    handlePlayerHit(shooterId, targetId, damage) {
        const shooterInfo = this.players.get(shooterId);
        const targetInfo = this.players.get(targetId);
        
        if (!shooterInfo || !targetInfo || shooterInfo.roomId !== targetInfo.roomId) {
            return null;
        }
        
        const room = this.rooms.get(shooterInfo.roomId);
        if (!room) return null;
        
        const shooter = room.players.get(shooterId);
        const target = room.players.get(targetId);
        
        if (!shooter || !target || !target.isAlive) return null;
        
        // 計算傷害
        target.health -= damage;
        
        if (target.health <= 0) {
            target.health = 0;
            target.isAlive = false;
            
            // 更新得分
            shooter.score.kills++;
            target.score.deaths++;
            
            console.log(`玩家 ${targetId} 被 ${shooterId} 擊殺`);
            
            // 延遲重生
            setTimeout(() => {
                target.health = 100;
                target.isAlive = true;
                target.position = { x: 0, y: 2, z: 0 };
                
                // 廣播重生事件
                io.to(room.id).emit('playerRespawn', {
                    playerId: targetId,
                    position: target.position,
                    health: target.health
                });
            }, 3000);
        }
        
        return {
            roomId: shooterInfo.roomId,
            shooterId,
            targetId,
            damage,
            targetHealth: target.health,
            isKill: target.health <= 0,
            shooterScore: shooter.score,
            targetScore: target.score
        };
    }
    
    getRoomList() {
        const roomList = [];
        for (const [roomId, room] of this.rooms) {
            roomList.push({
                id: roomId,
                playerCount: room.players.size,
                maxPlayers: room.settings.maxPlayers,
                gameState: room.gameState,
                gameMode: room.settings.gameMode,
                mapName: room.settings.mapName
            });
        }
        return roomList;
    }
}

const gameServer = new GameServer();

// Socket.IO 連接處理
io.on('connection', (socket) => {
    console.log(`玩家連接: ${socket.id}`);
    
    // 加入房間
    socket.on('joinRoom', (data) => {
        const { roomId, playerName } = data;
        const playerId = socket.id;
        
        const result = gameServer.joinRoom(roomId, playerId, {
            name: playerName || `玩家${playerId.substr(0, 6)}`,
            socketId: socket.id
        });
        
        if (result.success) {
            socket.join(roomId);
            
            // 通知玩家加入成功
            socket.emit('joinedRoom', {
                room: {
                    id: result.room.id,
                    settings: result.room.settings,
                    gameState: result.room.gameState
                },
                player: result.player,
                players: Array.from(result.room.players.values())
            });
            
            // 通知房間內其他玩家
            socket.to(roomId).emit('playerJoined', result.player);
            
            console.log(`玩家 ${playerId} 加入房間 ${roomId}`);
        } else {
            socket.emit('joinRoomError', result.error);
        }
    });
    
    // 玩家移動更新
    socket.on('playerUpdate', (data) => {
        const result = gameServer.updatePlayer(socket.id, data);
        if (result) {
            // 廣播給房間內其他玩家
            socket.to(result.room.id).emit('playerUpdate', {
                playerId: socket.id,
                ...data
            });
        }
    });
    
    // 玩家射擊
    socket.on('playerShoot', (data) => {
        const result = gameServer.handlePlayerShoot(socket.id, data);
        if (result) {
            // 廣播射擊事件
            io.to(result.roomId).emit('playerShoot', {
                shooterId: result.shooterId,
                ...result.shootData
            });
        }
    });
    
    // 玩家命中
    socket.on('playerHit', (data) => {
        const { targetId, damage } = data;
        const result = gameServer.handlePlayerHit(socket.id, targetId, damage);
        
        if (result) {
            // 廣播命中事件
            io.to(result.roomId).emit('playerHit', {
                shooterId: result.shooterId,
                targetId: result.targetId,
                damage: result.damage,
                targetHealth: result.targetHealth,
                isKill: result.isKill,
                shooterScore: result.shooterScore,
                targetScore: result.targetScore
            });
        }
    });
    
    // 獲取房間列表
    socket.on('getRoomList', () => {
        socket.emit('roomList', gameServer.getRoomList());
    });
    
    // 玩家斷線
    socket.on('disconnect', () => {
        const roomId = gameServer.leaveRoom(socket.id);
        if (roomId) {
            socket.to(roomId).emit('playerLeft', socket.id);
        }
        console.log(`玩家斷線: ${socket.id}`);
    });
});

// 靜態文件服務
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../krunker-game/index.html'));
});

// API 路由
app.get('/api/rooms', (req, res) => {
    res.json(gameServer.getRoomList());
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        rooms: gameServer.rooms.size,
        players: gameServer.players.size,
        uptime: process.uptime()
    });
});

// 啟動伺服器
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Krunker 遊戲伺服器運行在 http://0.0.0.0:${PORT}`);
});

// 優雅關閉
process.on('SIGINT', () => {
    console.log('正在關閉伺服器...');
    server.close(() => {
        console.log('伺服器已關閉');
        process.exit(0);
    });
});

module.exports = { app, server, io, gameServer };

