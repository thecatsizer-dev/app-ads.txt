// server.js - BACKEND SOCKET.IO PRODUCTION READY v5 (FREE TIER SAFE)
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

const INACTIVITY_TIMEOUT = 5 * 60 * 1000;

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

function validateMove(roomId, playerId, row, col, value) {
  const room = rooms[roomId];
  if (!room) {
    console.log('❌ Room introuvable');
    return false;
  }
  
  const player = room.players[playerId];
  if (!player) {
    console.log('❌ Player introuvable');
    return false;
  }
  
  // ✅ Case déjà remplie ?
  if (player.grid[row][col] !== 0) {
    console.log(`⚠️ Case (${row},${col}) déjà remplie`);
    return false;
  }
  
  // ✅ Compare UNIQUEMENT avec la solution
  const isCorrect = player.solution[row][col] === value;
  
  console.log(`${isCorrect ? '✅' : '❌'} (${row},${col}): ${value} vs ${player.solution[row][col]}`);
  
  return isCorrect;
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
            progress: 0, speed: 0, lastMoveTime: Date.now()
          },
          [opponent.playerId]: {
            playerId: opponent.playerId,
            playerName: opponent.playerName,
            socketId: opponent.socketId,
            grid: JSON.parse(JSON.stringify(puzzle)),
            solution: JSON.parse(JSON.stringify(solution)),
            correctMoves: 0, errors: 0, combo: 0, energy: 0,
            progress: 0, speed: 0, lastMoveTime: Date.now()
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
  
socket.on('cell_played', (data) => {
  const { roomId, playerId, row, col, value } = data;
  
  const room = rooms[roomId];
  if (!room) {
    console.log('❌ Room introuvable');
    return;
  }
  
  const player = room.players[playerId];
  if (!player) {
    console.log('❌ Player introuvable');
    return;
  }
  
  resetInactivityTimer(roomId);
  
  // ✅ VÉRIFICATION : Case déjà remplie ?
  if (player.grid[row][col] !== 0) {
    console.log(`⚠️ Case (${row},${col}) déjà remplie avec ${player.grid[row][col]}`);
    // ❌ Renvoyer une erreur au client pour qu'il ne compte pas ce coup
    socket.emit('move_rejected', {
      reason: 'cell_already_filled',
      row, col, value
    });
    return;
  }
  
  // ✅ Valider avec la solution
  const correctValue = player.solution[row][col];
  const isCorrect = (value === correctValue);
  
  console.log(`🎯 ${player.playerName} (${row},${col}): ${value} vs ${correctValue} → ${isCorrect ? '✅' : '❌'}`);
  
  // ✅ Toujours remplir la grille (même si faux)
  player.grid[row][col] = value;
  player.progress = calculateProgress(player.grid);
  
  const elapsed = (Date.now() - room.startTime) / 1000;
  
  if (isCorrect) {
    // ✅ BON COUP
    player.correctMoves++;
    player.combo++;
    
    // ⚡ ENERGY MODE POWERUP
    if (room.gameMode === 'powerup' && player.combo % 5 === 0 && player.combo > 0) {
      player.energy++;
      console.log(`⚡⚡⚡ ${player.playerName} +1 ÉNERGIE (combo ${player.combo}) → Total: ${player.energy}`);
      
      // ✅ Confirmer au client l'énergie gagnée
      socket.emit('energy_gained', {
        energy: player.energy,
        combo: player.combo
      });
    }
    
    console.log(`✅ ${player.playerName}: CORRECT | Combo: ${player.combo} | Progress: ${player.progress}/81`);
    
  } else {
    // ❌ MAUVAIS COUP
    player.errors++;
    player.combo = 0; // Reset combo
    console.log(`❌ ${player.playerName}: ERREUR | Combo reset | Errors: ${player.errors}`);
  }
  
  // ✅ Calcul vitesse
  player.speed = elapsed > 0 ? (player.correctMoves / elapsed) * 60 : 0;
  player.lastMoveTime = Date.now();
  
  // ✅ ENVOYER AU CLIENT (confirmation move)
  socket.emit('move_confirmed', {
    row, col, value,
    isCorrect,
    progress: player.progress,
    correctMoves: player.correctMoves,
    errors: player.errors,
    combo: player.combo,
    energy: player.energy,
    speed: Math.round(player.speed * 10) / 10
  });
  
  // ✅ BROADCAST À L'ADVERSAIRE
  const opponentSocketId = getOpponentSocketId(roomId, playerId);
  if (opponentSocketId) {
    io.to(opponentSocketId).emit('opponentProgress', {
      progress: player.progress,
      correctMoves: player.correctMoves,
      errors: player.errors,
      combo: player.combo,
      speed: Math.round(player.speed * 10) / 10,
      lastAction: isCorrect ? 'correct' : 'error',
      timestamp: Date.now()
    });
  }
  
  // 🏆 VICTOIRE ?
  if (player.progress === 81) {
    room.status = 'finished';
    
    const opponentId = Object.keys(room.players).find(id => id !== playerId);
    const opponent = room.players[opponentId];
    
    const winnerScore = calculateScore(player, elapsed);
    const loserScore = calculateScore(opponent, elapsed);
    
    console.log(`🏆 ${player.playerName} GAGNE! ${winnerScore}pts (${room.gameMode})`);
    
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
    
    setTimeout(() => {
      delete rooms[roomId];
      console.log(`🗑️ Room ${roomId} supprimée`);
    }, 5000);
  }
});
  
 socket.on('trigger_power', (data) => {
  const { roomId, playerId } = data;
  
  const room = rooms[roomId];
  if (!room || room.gameMode !== 'powerup') {
    console.log(`⚠️ Power-ups désactivés (room: ${!!room}, mode: ${room?.gameMode})`);
    return;
  }
  
  const player = room.players[playerId];
  if (!player) {
    console.log(`⚠️ Player introuvable`);
    return;
  }
  
  if (player.energy < 1) {
    console.log(`⚠️ ${player.playerName} pas assez d'énergie (${player.energy})`);
    socket.emit('power_failed', { reason: 'insufficient_energy' });
    return;
  }
  
  // ✅ Consommer l'énergie
  player.energy--;
  
  // ✅ Power-ups disponibles
  const powers = [
    { type: 'fog', duration: 2000 },      // Brouillard
    { type: 'stun', duration: 1500 },     // Étourdissement
    { type: 'flash', duration: 1000 },    // Flash
    { type: 'shake', duration: 1500 }     // Tremblement
  ];
  
  const randomPower = powers[Math.floor(Math.random() * powers.length)];
  
  console.log(`⚡⚡⚡ ${player.playerName} utilise ${randomPower.type} (${player.energy} énergie restante)`);
  
  // ✅ Confirmer au joueur qui lance
  socket.emit('power_used', {
    type: randomPower.type,
    energy: player.energy
  });
  
  // ✅ Envoyer à l'adversaire
  const opponentSocketId = getOpponentSocketId(roomId, playerId);
  if (opponentSocketId) {
    console.log(`📤 Envoi power ${randomPower.type} à l'adversaire (socket: ${opponentSocketId})`);
    io.to(opponentSocketId).emit('powerup_triggered', {
      type: randomPower.type,
      duration: randomPower.duration
    });
  } else {
    console.log(`❌ Adversaire introuvable`);
  }
});
  
  socket.on('updateProgress', (data) => {
    const { roomId, playerId, progress } = data;
    
    const room = rooms[roomId];
    if (!room) return;
    
    const player = room.players[playerId];
    if (!player) return;
    
    player.progress = progress;
    
    const opponentSocketId = getOpponentSocketId(roomId, playerId);
    if (opponentSocketId) {
      io.to(opponentSocketId).emit('opponentProgress', {
        progress: player.progress,
        correctMoves: player.correctMoves,
        errors: player.errors,
        combo: player.combo,
        speed: Math.round(player.speed * 10) / 10,
        lastAction: '',
        timestamp: Date.now()
      });
    }
  });
  
  socket.on('gameEnd', (data) => {
    const { roomId, playerId, score, timeInSeconds } = data;
    const room = rooms[roomId];
    if (!room) return;
    
    console.log(`🏁 ${playerId}: ${score}pts en ${timeInSeconds}s`);
  });
  
  socket.on('disconnect', () => {
    console.log('🔌 Déconnexion:', socket.id);
    
    [classicQueue, powerupQueue].forEach((queue) => {
      const index = queue.findIndex(p => p.socketId === socket.id);
      if (index !== -1) {
        const player = queue.splice(index, 1)[0];
        console.log(`🚪 ${player.playerName} retiré (déco)`);
      }
    });
    
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const disconnected = Object.values(room.players).find(p => p.socketId === socket.id);
      
      if (disconnected) {
        console.log(`⚠️ ${disconnected.playerName} déco en partie`);
        
        const opponentId = Object.keys(room.players).find(id => id !== disconnected.playerId);
        const opponentSocketId = room.players[opponentId]?.socketId;
        
        if (opponentSocketId) {
          io.to(opponentSocketId).emit('opponentDisconnected');
          io.to(opponentSocketId).emit('game_over', {
            winnerId: opponentId,
            winnerName: room.players[opponentId].playerName,
            winnerScore: 1000,
            loserId: disconnected.playerId,
            loserName: disconnected.playerName,
            loserScore: 0,
            reason: 'opponent_left'
          });
        }
        
        if (room.inactivityTimer) clearTimeout(room.inactivityTimer);
        delete rooms[roomId];
        console.log(`🗑️ Room ${roomId} supprimée (déco)`);
        break;
      }
    }
    
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
    message: 'Sudoku Server is running',
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
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + ' MB'
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/stats', (req, res) => {
  res.json({
    rooms: Object.keys(rooms).map(id => ({
      roomId: id,
      gameMode: rooms[id].gameMode,
      players: Object.keys(rooms[id].players).length,
      status: rooms[id].status,
      uptime: Date.now() - rooms[id].startTime
    })),
    classicQueue: classicQueue.map(p => ({ name: p.playerName })),
    powerupQueue: powerupQueue.map(p => ({ name: p.playerName }))
  });
});

// ========== LOGS PÉRIODIQUES ==========

setInterval(() => {
  console.log('📊 ========== STATS ==========');
  console.log(`   Rooms: ${Object.keys(rooms).length}`);
  console.log(`   Classic Queue: ${classicQueue.length}`);
  console.log(`   Power-Up Queue: ${powerupQueue.length}`);
  console.log(`   Players: ${Object.keys(connectedSockets).length}`);
  console.log(`   Uptime: ${Math.round(process.uptime())}s`);
  console.log('==============================');
}, 300000);

// ========== DÉMARRAGE SERVEUR ==========

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur Socket.io démarré sur le port ${PORT}`);
  console.log(`🌐 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Stats: http://localhost:${PORT}/stats`);
});


