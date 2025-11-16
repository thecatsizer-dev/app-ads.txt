// server.js - BACKEND SOCKET.IO PRODUCTION READY v7 - FINAL ULTIMATE FIX
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ✅ CONFIGURATION SOCKET.IO OPTIMISÉE POUR RENDER
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 20000,
  pingInterval: 10000,
  connectTimeout: 10000,
  upgradeTimeout: 10000,
  serveClient: false,
  perMessageDeflate: false
});

app.use(cors());
app.use(express.json());

// ========== STRUCTURES DE DONNÉES ==========

const rooms = {};
const classicQueue = [];
const powerupQueue = [];
const connectedSockets = {};
const disconnectedPlayers = {}; // ✅ NOUVEAU: Pour reconnexion

const INACTIVITY_TIMEOUT = 5 * 60 * 1000;
const RECONNECT_TIMEOUT = 30000; // 30 secondes

// ========== HELPER FUNCTIONS ==========

function generateRoomId() {
  return 'room_' + Math.random().toString(36).substr(2, 9);
}

function getOpponentSocketId(roomId, playerId) {
  const room = rooms[roomId];
  if (!room) return null;
  
  const opponentId = Object.keys(room.players).find(id => id !== playerId);
  return connectedSockets[opponentId];
}

function calculateProgress(grid) {
  let filled = 0;
  for (let row of grid) {
    for (let cell of row) {
      if (cell !== 0) filled++;
    }
  }
  return filled;
}

function calculateScore(player, timeInSeconds) {
  const baseScore = 1000;
  const timeBonus = Math.max(0, 3600 - timeInSeconds);
  const errorPenalty = player.errors * 50;
  const comboBonus = player.combo * 10;
  
  return Math.max(0, baseScore + timeBonus - errorPenalty + comboBonus);
}

// ========== GÉNÉRATEUR SUDOKU ==========
function generateSudokuPuzzle(difficulty) {
  const baseGrid = [
    [5, 3, 4, 6, 7, 8, 9, 1, 2],
    [6, 7, 2, 1, 9, 5, 3, 4, 8],
    [1, 9, 8, 3, 4, 2, 5, 6, 7],
    [8, 5, 9, 7, 6, 1, 4, 2, 3],
    [4, 2, 6, 8, 5, 3, 7, 9, 1],
    [7, 1, 3, 9, 2, 4, 8, 5, 6],
    [9, 6, 1, 5, 3, 7, 2, 8, 4],
    [2, 8, 7, 4, 1, 9, 6, 3, 5],
    [3, 4, 5, 2, 8, 6, 1, 7, 9]
  ];
  
  const puzzle = JSON.parse(JSON.stringify(baseGrid));
  const cellsToRemove = difficulty === 'easy' ? 35 : difficulty === 'medium' ? 45 : 55;
  
  let removed = 0;
  const attempts = new Set();
  
  while (removed < cellsToRemove && attempts.size < 81) {
    const row = Math.floor(Math.random() * 9);
    const col = Math.floor(Math.random() * 9);
    const key = `${row}-${col}`;
    
    if (!attempts.has(key) && puzzle[row][col] !== 0) {
      puzzle[row][col] = 0;
      removed++;
      attempts.add(key);
    }
  }
  
  return puzzle;
}

function getSolution() {
  return [
    [5, 3, 4, 6, 7, 8, 9, 1, 2],
    [6, 7, 2, 1, 9, 5, 3, 4, 8],
    [1, 9, 8, 3, 4, 2, 5, 6, 7],
    [8, 5, 9, 7, 6, 1, 4, 2, 3],
    [4, 2, 6, 8, 5, 3, 7, 9, 1],
    [7, 1, 3, 9, 2, 4, 8, 5, 6],
    [9, 6, 1, 5, 3, 7, 2, 8, 4],
    [2, 8, 7, 4, 1, 9, 6, 3, 5],
    [3, 4, 5, 2, 8, 6, 1, 7, 9]
  ];
}

function setupInactivityTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  
  room.inactivityTimer = setTimeout(() => {
    console.log(`⏰ Timeout inactivité - Room ${roomId}`);
    
    Object.values(room.players).forEach(player => {
      io.to(player.socketId).emit('game_over', {
        winnerId: null,
        winnerName: null,
        winnerScore: 0,
        loserId: null,
        loserName: null,
        loserScore: 0,
        reason: 'inactivity'
      });
    });
    
    delete rooms[roomId];
  }, INACTIVITY_TIMEOUT);
}

function resetInactivityTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  
  if (room.inactivityTimer) {
    clearTimeout(room.inactivityTimer);
  }
  setupInactivityTimer(roomId);
}

// ========== SOCKET.IO EVENTS ==========

io.on('connection', (socket) => {
  console.log('🔌 Client connecté:', socket.id);
  
  socket.on('player_connected', (data) => {
    const { playerId, playerName } = data;
    connectedSockets[playerId] = socket.id;
    
    // ✅ VÉRIFIER SI RECONNEXION
    if (disconnectedPlayers[playerId]) {
      const { roomId, timeout } = disconnectedPlayers[playerId];
      const room = rooms[roomId];
      
      if (room) {
        clearTimeout(timeout);
        delete disconnectedPlayers[playerId];
        
        // ✅ METTRE À JOUR SOCKET ID
        room.players[playerId].socketId = socket.id;
        
        console.log(`✅ ${playerName} RECONNECTÉ!`);
        
        // ✅ RENVOYER ÉTAT DU JEU
        socket.emit('reconnected', {
          roomId,
          gameState: room.players[playerId],
          opponentName: Object.values(room.players).find(p => p.playerId !== playerId)?.playerName
        });
        
        // ✅ NOTIFIER ADVERSAIRE
        const opponentSocketId = getOpponentSocketId(roomId, playerId);
        if (opponentSocketId) {
          io.to(opponentSocketId).emit('opponent_reconnected', {
            playerName
          });
        }
        
        return;
      }
    }
    
    console.log(`✅ Joueur enregistré: ${playerName} (${playerId})`);
    socket.emit('connection_confirmed', { success: true, playerId });
  });
  
  socket.on('joinQueue', (data) => {
    const { playerId, playerName, gameMode } = data;
    console.log(`🔍 ${playerName} recherche en ${gameMode}...`);
    
    const queue = gameMode === 'classic' ? classicQueue : powerupQueue;
    
    if (queue.find(p => p.playerId === playerId)) {
      console.log(`⚠️ Déjà en queue`);
      return;
    }
    
    if (queue.length > 0) {
      const opponent = queue.shift();
      const roomId = generateRoomId();
      const puzzle = generateSudokuPuzzle('medium');
      const solution = getSolution();
      
      rooms[roomId] = {
        roomId,
        gameMode,
        players: {
          [playerId]: {
            playerId, playerName,
            socketId: socket.id,
            grid: JSON.parse(JSON.stringify(puzzle)),
            solution: JSON.parse(JSON.stringify(solution)),
            correctMoves: 0, errors: 0, combo: 0, energy: 0,
            progress: calculateProgress(puzzle), speed: 0, lastMoveTime: Date.now()
          },
          [opponent.playerId]: {
            playerId: opponent.playerId,
            playerName: opponent.playerName,
            socketId: opponent.socketId,
            grid: JSON.parse(JSON.stringify(puzzle)),
            solution: JSON.parse(JSON.stringify(solution)),
            correctMoves: 0, errors: 0, combo: 0, energy: 0,
            progress: calculateProgress(puzzle), speed: 0, lastMoveTime: Date.now()
          }
        },
        status: 'playing',
        startTime: Date.now()
      };
      
      setupInactivityTimer(roomId);
      
      console.log(`🎮 Match ${gameMode}: ${playerName} vs ${opponent.playerName}`);
      
      io.to(socket.id).emit('matchFound', {
        roomId, opponentName: opponent.playerName, puzzle, gameMode
      });
      io.to(opponent.socketId).emit('matchFound', {
        roomId, opponentName: playerName, puzzle, gameMode
      });
      
    } else {
      queue.push({ playerId, playerName, socketId: socket.id });
      socket.emit('waiting');
      console.log(`⏳ ${playerName} en attente (${gameMode})`);
    }
  });
  
  socket.on('leaveQueue', () => {
    [classicQueue, powerupQueue].forEach((queue, idx) => {
      const index = queue.findIndex(p => p.socketId === socket.id);
      if (index !== -1) {
        const player = queue.splice(index, 1)[0];
        console.log(`🚪 ${player.playerName} quitte queue ${idx === 0 ? 'Classic' : 'Power-Up'}`);
      }
    });
  });
  
  // ========== ✅ UPDATE PROGRESS (DEPUIS CLIENT) ==========
  socket.on('updateProgress', (data) => {
    const { roomId, playerId, progress, correctMoves, errors, combo, speed } = data;
    
    const room = rooms[roomId];
    if (!room) return;
    
    const player = room.players[playerId];
    if (!player) return;
    
    resetInactivityTimer(roomId);
    
    // ✅ MISE À JOUR DES STATS
    player.progress = progress;
    player.correctMoves = correctMoves || player.correctMoves;
    player.errors = errors || player.errors;
    player.combo = combo || player.combo;
    player.speed = speed || player.speed;
    
    // ⚡ ENERGY MODE POWERUP (tous les 5 combo)
    if (room.gameMode === 'powerup' && combo > 0 && combo % 5 === 0) {
      const previousEnergy = player.energy;
      const expectedEnergy = Math.floor(combo / 5);
      
      if (expectedEnergy > previousEnergy) {
        player.energy = expectedEnergy;
        console.log(`⚡⚡⚡ ${player.playerName} ÉNERGIE +1 (combo ${combo}) → Total: ${player.energy}`);
      }
    }
    
    console.log(`📊 ${player.playerName} - Progress: ${progress}/81 | Combo: ${combo} | Energy: ${player.energy}`);
    
    // ✅ BROADCAST À L'ADVERSAIRE
    const opponentSocketId = getOpponentSocketId(roomId, playerId);
    if (opponentSocketId) {
      io.to(opponentSocketId).emit('opponentProgress', {
        progress: player.progress,
        correctMoves: player.correctMoves,
        errors: player.errors,
        combo: player.combo,
        speed: Math.round(player.speed * 10) / 10,
        lastAction: ''
      });
    }
    
    // 🏆 VICTOIRE ?
    if (progress >= 81) {
      room.status = 'finished';
      
      const opponentId = Object.keys(room.players).find(id => id !== playerId);
      const opponent = room.players[opponentId];
      
      const elapsed = (Date.now() - room.startTime) / 1000;
      const winnerScore = calculateScore(player, elapsed);
      const loserScore = calculateScore(opponent, elapsed);
      
      console.log(`🏆 ${player.playerName} GAGNE! ${winnerScore}pts vs ${loserScore}pts`);
      
      const result = {
        winnerId: playerId,
        winnerName: player.playerName,
        winnerScore,
        loserId: opponentId,
        loserName: opponent.playerName,
        loserScore,
        reason: 'completed'
      };
      
      io.to(player.socketId).emit('game_over', result);
      io.to(opponent.socketId).emit('game_over', result);
      
      if (room.inactivityTimer) clearTimeout(room.inactivityTimer);
      setTimeout(() => delete rooms[roomId], 5000);
    }
  });
  
  // ========== ⚡ TRIGGER POWER-UP (40% sur soi / 60% adversaire) ==========
  socket.on('trigger_power', (data) => {
    const { roomId, playerId } = data;
    
    const room = rooms[roomId];
    if (!room || room.gameMode !== 'powerup') {
      console.log(`⚠️ Power-ups désactivés`);
      return;
    }
    
    const player = room.players[playerId];
    if (!player) return;
    
    if (player.energy < 1) {
      console.log(`⚠️ ${player.playerName} pas assez d'énergie (${player.energy})`);
      return;
    }
    
    // ✅ CONSOMMER ÉNERGIE
    player.energy--;
    
    const powers = [
      { type: 'fog', duration: 2000 },
      { type: 'flash', duration: 1000 },
      { type: 'stun', duration: 1500 },
      { type: 'shake', duration: 1500 }
    ];
    
    const randomPower = powers[Math.floor(Math.random() * powers.length)];
    
    // ✅ PROBABILITÉ 40/60
    const random = Math.random();
    const targetSelf = random < 0.40; // 40% sur soi-même
    
    const opponentSocketId = getOpponentSocketId(roomId, playerId);
    
    if (targetSelf) {
      console.log(`⚡ ${player.playerName} → ${randomPower.type} SUR LUI-MÊME (40%)`);
      socket.emit('powerup_triggered', {
        type: randomPower.type,
        duration: randomPower.duration
      });
    } else {
      console.log(`⚡ ${player.playerName} → ${randomPower.type} SUR ADVERSAIRE (60%)`);
      if (opponentSocketId) {
        io.to(opponentSocketId).emit('powerup_triggered', {
          type: randomPower.type,
          duration: randomPower.duration
        });
      }
    }
  });
  
  socket.on('gameEnd', (data) => {
    const { roomId, playerId, score, timeInSeconds } = data;
    console.log(`🏁 ${playerId}: ${score}pts en ${timeInSeconds}s`);
  });

  // ========== ✅ ABANDON VOLONTAIRE ==========
socket.on('playerAbandoned', (data) => {
  const { roomId, playerId } = data;
  
  const room = rooms[roomId];
  if (!room) return;
  
  console.log(`🚪 ${room.players[playerId]?.playerName} ABANDONNE`);
  
  const opponentId = Object.keys(room.players).find(id => id !== playerId);
  const opponent = room.players[opponentId];
  const abandoned = room.players[playerId];
  
  if (opponent && abandoned) {
    const elapsed = (Date.now() - room.startTime) / 1000;
    const winnerScore = calculateScore(opponent, elapsed);
    const loserScore = 0; // Perdant = 0 points
    
    const result = {
      winnerId: opponentId,
      winnerName: opponent.playerName,
      winnerScore,
      loserId: playerId,
      loserName: abandoned.playerName,
      loserScore,
      reason: 'opponent_abandoned'
    };
    
    // ✅ NOTIFIER LES DEUX
    io.to(opponent.socketId).emit('game_over', result);
    io.to(abandoned.socketId).emit('game_over', result);
    
    console.log(`🏆 ${opponent.playerName} gagne par abandon (${winnerScore}pts)`);
  }
  
  // ✅ CLEANUP IMMÉDIAT
  if (room.inactivityTimer) clearTimeout(room.inactivityTimer);
  
  // ✅ ANNULER TIMEOUT RECONNEXION SI EXISTANT
  if (disconnectedPlayers[playerId]) {
    clearTimeout(disconnectedPlayers[playerId].timeout);
    delete disconnectedPlayers[playerId];
  }
  
  delete rooms[roomId];
});
  
  socket.on('disconnect', () => {
    console.log('🔌 Déconnexion:', socket.id);
    
    // ✅ RETIRER DES QUEUES
    [classicQueue, powerupQueue].forEach((queue) => {
      const index = queue.findIndex(p => p.socketId === socket.id);
      if (index !== -1) {
        const player = queue.splice(index, 1)[0];
        console.log(`🚪 ${player.playerName} retiré (déco)`);
      }
    });
    
    // ✅ CHERCHER SI EN PARTIE ACTIVE
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const disconnected = Object.values(room.players).find(p => p.socketId === socket.id);
      
      if (disconnected) {
        console.log(`⚠️ ${disconnected.playerName} déco - ATTENTE 30s`);
        
        // ✅ MARQUER COMME DÉCONNECTÉ TEMPORAIREMENT
        disconnectedPlayers[disconnected.playerId] = {
          roomId,
          timestamp: Date.now(),
          timeout: setTimeout(() => {
  console.log(`⏰ ${disconnected.playerName} n'est pas revenu - ABANDON`);
  
  const opponentId = Object.keys(room.players).find(id => id !== disconnected.playerId);
  const opponent = room.players[opponentId];
  
  if (opponent) {
    const elapsed = (Date.now() - room.startTime) / 1000;
    const winnerScore = calculateScore(opponent, elapsed);
    const loserScore = 0;
    
    const result = {
      winnerId: opponentId,
      winnerName: opponent.playerName,
      winnerScore,
      loserId: disconnected.playerId,
      loserName: disconnected.playerName,
      loserScore,
      reason: 'opponent_abandoned'
    };
    
    // ✅ NOTIFIER ADVERSAIRE (GAGNANT)
    io.to(opponent.socketId).emit('game_over', result);
    
    // ✅ NOTIFIER AUSSI "opponentDisconnected" POUR CLEANUP UI
    io.to(opponent.socketId).emit('opponentDisconnected');
  }
  
  if (room.inactivityTimer) clearTimeout(room.inactivityTimer);
  delete rooms[roomId];
  delete disconnectedPlayers[disconnected.playerId];
}, RECONNECT_TIMEOUT) // 30 secondes
        };
        
        // ✅ NOTIFIER ADVERSAIRE DE LA DÉCONNEXION TEMPORAIRE
        const opponentId = Object.keys(room.players).find(id => id !== disconnected.playerId);
        const opponentSocketId = room.players[opponentId]?.socketId;
        
        if (opponentSocketId) {
          io.to(opponentSocketId).emit('opponent_disconnected_temp', {
            playerName: disconnected.playerName,
            waitTime: 30
          });
        }
        
        break;
      }
    }
    
    // ✅ NETTOYER CONNECTED SOCKETS
    for (const playerId in connectedSockets) {
      if (connectedSockets[playerId] === socket.id) {
        delete connectedSockets[playerId];
        break;
      }
    }
  });
});

// ========== ROUTES API ==========

app.get('/', (req, res) => {
  res.json({
    status: 'alive',
    message: 'Sudoku Server v7 - ULTIMATE',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    rooms: Object.keys(rooms).length,
    classicQueue: classicQueue.length,
    powerupQueue: powerupQueue.length,
    connectedPlayers: Object.keys(connectedSockets).length,
    disconnectedPlayers: Object.keys(disconnectedPlayers).length,
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB'
    }
  });
});

app.get('/stats', (req, res) => {
  res.json({
    rooms: Object.keys(rooms).map(id => ({
      roomId: id,
      gameMode: rooms[id].gameMode,
      players: Object.keys(rooms[id].players).map(pid => ({
        name: rooms[id].players[pid].playerName,
        progress: rooms[id].players[pid].progress,
        combo: rooms[id].players[pid].combo,
        energy: rooms[id].players[pid].energy
      }))
    })),
    classicQueue: classicQueue.map(p => ({ name: p.playerName })),
    powerupQueue: powerupQueue.map(p => ({ name: p.playerName })),
    disconnectedPlayers: Object.keys(disconnectedPlayers).length
  });
});

setInterval(() => {
  console.log('📊 ========== STATS ==========');
  console.log(`   Rooms: ${Object.keys(rooms).length}`);
  console.log(`   Classic Queue: ${classicQueue.length}`);
  console.log(`   Power-Up Queue: ${powerupQueue.length}`);
  console.log(`   Players: ${Object.keys(connectedSockets).length}`);
  console.log(`   Disconnected: ${Object.keys(disconnectedPlayers).length}`);
  console.log('==============================');
}, 300000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur v7 ULTIMATE sur port ${PORT}`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);
  console.log(`📊 Stats: http://localhost:${PORT}/stats`);
});

