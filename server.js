// server.js - BACKEND SOCKET.IO PRODUCTION READY v11 - FIX INACTIVITY VICTORY POPUP
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

// ✅ CONFIGURATION SOCKET.IO OPTIMISÉE
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  upgradeTimeout: 30000,
  serveClient: false,
  perMessageDeflate: false
});

app.use(cors());
app.use(express.json());

// ========== STRUCTURES DE DONNÉES ==========

const rooms = {};

const queues = {
  classic: {
    easy: [],
    medium: [],
    hard: [],
    expert: []
  },
  powerup: {
    easy: [],
    medium: [],
    hard: [],
    expert: []
  }
};

const connectedSockets = {};
const disconnectedPlayers = {};

// ✅✅✅ NOUVEAU - Historique des parties terminées (garde 5 minutes)
const finishedGames = {}; // { playerId: { result, timestamp } }

const INACTIVITY_TIMEOUT = 3 * 60 * 1000; // 3 MINUTES
const RECONNECT_TIMEOUT = 60000; // 60 SECONDES
const FINISHED_GAME_TTL = 5 * 60 * 1000; // 5 minutes

// ✅ Cleanup automatique des parties terminées
setInterval(() => {
  const now = Date.now();
  for (const playerId in finishedGames) {
    if (now - finishedGames[playerId].timestamp > FINISHED_GAME_TTL) {
      delete finishedGames[playerId];
      console.log(`🧹 Partie terminée supprimée pour ${playerId}`);
    }
  }
}, 60000); // Toutes les 60 secondes

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

function getDifficultyConfig(difficulty) {
  const configs = {
    easy: { cellsToRemove: 35, name: 'easy' },
    medium: { cellsToRemove: 45, name: 'medium' },
    hard: { cellsToRemove: 55, name: 'hard' },
    expert: { cellsToRemove: 65, name: 'expert' }
  };
  
  return configs[difficulty] || configs.medium;
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
  const config = getDifficultyConfig(difficulty);
  
  let removed = 0;
  const attempts = new Set();
  
  while (removed < config.cellsToRemove && attempts.size < 81) {
    const row = Math.floor(Math.random() * 9);
    const col = Math.floor(Math.random() * 9);
    const key = `${row}-${col}`;
    
    if (!attempts.has(key) && puzzle[row][col] !== 0) {
      puzzle[row][col] = 0;
      removed++;
      attempts.add(key);
    }
  }
  
  console.log(`🎲 Puzzle ${difficulty}: ${removed} cases retirées`);
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

// ✅✅✅ TIMER INDIVIDUEL PAR JOUEUR
function setupPlayerInactivityTimer(roomId, playerId) {
  const room = rooms[roomId];
  if (!room) return;
  
  const player = room.players[playerId];
  if (!player) return;
  
  if (player.inactivityTimer) {
    clearTimeout(player.inactivityTimer);
  }
  
  player.inactivityTimer = setTimeout(() => {
    console.log(`⏰ INACTIVITÉ 3min - ${player.playerName} dans ${roomId}`);
    
    if (!rooms[roomId]) return;
    
    const opponent = Object.values(room.players).find(p => p.playerId !== playerId);
    if (!opponent) return;
    
    const elapsed = Math.floor((Date.now() - room.startTime) / 1000);
    
    const opponentScore = 2500;
    const inactiveScore = 0;
    
    console.log(`🏆 ${opponent.playerName} GAGNE par inactivité de ${player.playerName}`);
    console.log(`   Score gagnant: ${opponentScore} pts (bonus AFK)`);
    
    const result = {
      winnerId: opponent.playerId,
      winnerName: opponent.playerName,
      winnerScore: opponentScore,
      loserId: playerId,
      loserName: player.playerName,
      loserScore: inactiveScore,
      reason: 'inactivity'
    };
    
    room.status = 'finished';
    
    // ✅✅✅ SAUVEGARDER LE RÉSULTAT POUR RECONNEXION
    finishedGames[opponent.playerId] = {
      result,
      timestamp: Date.now()
    };
    finishedGames[playerId] = {
      result,
      timestamp: Date.now()
    };
    
    console.log(`💾 Résultat sauvegardé pour reconnexion des 2 joueurs`);
    
    // Envoyer game_over
    io.to(opponent.socketId).emit('game_over', result);
    io.to(player.socketId).emit('game_over', result);
    
    // Forcer la déconnexion
    const opponentSocket = io.sockets.sockets.get(opponent.socketId);
    const playerSocket = io.sockets.sockets.get(player.socketId);
    
    if (opponentSocket) {
      opponentSocket.emit('force_leave_room', { reason: 'inactivity', result });
    }
    if (playerSocket) {
      playerSocket.emit('force_leave_room', { reason: 'inactivity', result });
    }
    
    // Cleanup timers
    Object.values(room.players).forEach(p => {
      if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
    });
    
    // Supprimer la room
    delete rooms[roomId];
    console.log(`🏁 Room ${roomId} supprimée (inactivité)`);
    
  }, INACTIVITY_TIMEOUT);
  
  console.log(`⏱️ Timer inactivité démarré pour ${player.playerName}`);
}

function resetPlayerInactivityTimer(roomId, playerId) {
  const room = rooms[roomId];
  if (!room) return;
  
  const player = room.players[playerId];
  if (!player) return;
  
  player.lastMoveTime = Date.now();
  
  if (player.inactivityTimer) {
    clearTimeout(player.inactivityTimer);
  }
  
  setupPlayerInactivityTimer(roomId, playerId);
  
  console.log(`⏱️ Timer reset pour ${player.playerName}`);
}

function tryMatchmaking(socket, playerId, playerName, gameMode, difficulty) {
  const queue = queues[gameMode][difficulty];
  
  console.log(`🔍 ${playerName} cherche: ${gameMode}/${difficulty} (${queue.length} en attente)`);
  
  if (queue.length > 0) {
    const opponent = queue.shift();
    const roomId = generateRoomId();
    const puzzle = generateSudokuPuzzle(difficulty);
    const solution = getSolution();
    
    const frozenInitialPuzzle = JSON.parse(JSON.stringify(puzzle));
    
    rooms[roomId] = {
      roomId,
      gameMode,
      difficulty,
      initialPuzzle: frozenInitialPuzzle,
      players: {
        [playerId]: {
          playerId, playerName,
          socketId: socket.id,
          grid: JSON.parse(JSON.stringify(puzzle)),
          solution: JSON.parse(JSON.stringify(solution)),
          correctMoves: 0, errors: 0, combo: 0, energy: 0,
          progress: calculateProgress(puzzle), speed: 0, 
          lastMoveTime: Date.now(),
          inactivityTimer: null
        },
        [opponent.playerId]: {
          playerId: opponent.playerId,
          playerName: opponent.playerName,
          socketId: opponent.socketId,
          grid: JSON.parse(JSON.stringify(puzzle)),
          solution: JSON.parse(JSON.stringify(solution)),
          correctMoves: 0, errors: 0, combo: 0, energy: 0,
          progress: calculateProgress(puzzle), speed: 0, 
          lastMoveTime: Date.now(),
          inactivityTimer: null
        }
      },
      status: 'playing',
      startTime: Date.now()
    };
    
    setupPlayerInactivityTimer(roomId, playerId);
    setupPlayerInactivityTimer(roomId, opponent.playerId);
    
    console.log(`🎮 Match ${gameMode}/${difficulty}: ${playerName} vs ${opponent.playerName}`);
    
    io.to(socket.id).emit('matchFound', {
      roomId, 
      opponentName: opponent.playerName, 
      puzzle, 
      solution,
      gameMode,
      difficulty
    });
    
    io.to(opponent.socketId).emit('matchFound', {
      roomId, 
      opponentName: playerName, 
      puzzle, 
      solution,
      gameMode,
      difficulty
    });
    
    return true;
  }
  
  return false;
}

// ========== SOCKET.IO EVENTS ==========

io.on('connection', (socket) => {
  console.log('🔌 Client connecté:', socket.id);
  
  socket.emit('connection_established', { 
    socketId: socket.id,
    timestamp: Date.now() 
  });
  
  socket.on('player_connected', (data) => {
    const { playerId, playerName } = data;
    
    console.log(`📝 Enregistrement: ${playerName} (${playerId})`);
    
    connectedSockets[playerId] = socket.id;
    
    // ✅✅✅ VÉRIFIER SI PARTIE TERMINÉE RÉCEMMENT
    if (finishedGames[playerId]) {
      const { result, timestamp } = finishedGames[playerId];
      
      console.log(`🎮 PARTIE TERMINÉE DÉTECTÉE pour ${playerName}`);
      console.log(`   Résultat: ${result.reason}`);
      console.log(`   Winner: ${result.winnerName} | Loser: ${result.loserName}`);
      
      // Envoyer immédiatement le résultat
      socket.emit('game_over', result);
      
      // Nettoyer
      delete finishedGames[playerId];
      
      socket.emit('connection_confirmed', { success: true, playerId });
      return;
    }
    
    // ✅ RECONNEXION NORMALE
    if (disconnectedPlayers[playerId]) {
      const { roomId, timeout } = disconnectedPlayers[playerId];
      const room = rooms[roomId];
      
      if (room && room.players[playerId]) {
        clearTimeout(timeout);
        delete disconnectedPlayers[playerId];
        
        room.players[playerId].socketId = socket.id;
        
        setupPlayerInactivityTimer(roomId, playerId);
        const opponent = Object.values(room.players).find(p => p.playerId !== playerId);
        if (opponent) {
          setupPlayerInactivityTimer(roomId, opponent.playerId);
        }
        
        console.log(`✅ ${playerName} RECONNECTÉ à ${roomId}!`);
        
        const player = room.players[playerId];
        
        socket.emit('reconnection_dialog', {
          roomId,
          gameMode: room.gameMode,
          difficulty: room.difficulty,
          opponentName: opponent?.playerName || 'Adversaire',
          puzzle: player.grid,
          initialPuzzle: room.initialPuzzle,
          solution: player.solution,
          myProgress: player.progress,
          opponentProgress: opponent?.progress || 0,
          myStats: {
            correctMoves: player.correctMoves,
            errors: player.errors,
            combo: player.combo,
            energy: player.energy,
            speed: player.speed
          },
          elapsedSeconds: Math.floor((Date.now() - room.startTime) / 1000)
        });
        
        const opponentSocketId = getOpponentSocketId(roomId, playerId);
        if (opponentSocketId) {
          io.to(opponentSocketId).emit('opponent_reconnected', { playerName });
        }
        
        return;
      }
    }
    
    console.log(`✅ Joueur enregistré: ${playerName}`);
    socket.emit('connection_confirmed', { success: true, playerId });
  });
  
  socket.on('joinQueue', (data) => {
    const { playerId, playerName, gameMode, difficulty = 'medium' } = data;
    
    const validDifficulties = ['easy', 'medium', 'hard', 'expert'];
    const validModes = ['classic', 'powerup'];
    
    if (!validModes.includes(gameMode)) {
      console.log(`⚠️ Mode invalide: ${gameMode}`);
      return;
    }
    
    const safeDifficulty = validDifficulties.includes(difficulty) ? difficulty : 'medium';
    
    console.log(`🔍 ${playerName} recherche: ${gameMode}/${safeDifficulty}`);
    
    for (const mode in queues) {
      for (const diff in queues[mode]) {
        const index = queues[mode][diff].findIndex(p => p.playerId === playerId);
        if (index !== -1) {
          console.log(`⚠️ Déjà en queue ${mode}/${diff} - Retrait`);
          queues[mode][diff].splice(index, 1);
        }
      }
    }
    
    const matched = tryMatchmaking(socket, playerId, playerName, gameMode, safeDifficulty);
    
    if (!matched) {
      queues[gameMode][safeDifficulty].push({ 
        playerId, 
        playerName, 
        socketId: socket.id,
        timestamp: Date.now()
      });
      
      socket.emit('waiting');
      console.log(`⏳ ${playerName} en attente (${gameMode}/${safeDifficulty})`);
    }
  });
  
  socket.on('leaveQueue', () => {
    for (const mode in queues) {
      for (const difficulty in queues[mode]) {
        const index = queues[mode][difficulty].findIndex(p => p.socketId === socket.id);
        if (index !== -1) {
          const player = queues[mode][difficulty].splice(index, 1)[0];
          console.log(`🚪 ${player.playerName} quitte queue ${mode}/${difficulty}`);
        }
      }
    }
  });
  
  socket.on('updateProgress', (data) => {
    const { roomId, playerId, progress } = data;
    
    const room = rooms[roomId];
    if (!room) return;
    
    const player = room.players[playerId];
    if (!player) return;
    
    console.log(`⚠️ updateProgress DEPRECATED - Utilisez cell_played`);
  });
  
  socket.on('cell_played', (data) => {
    const { roomId, playerId, row, col, value } = data;
    
    const room = rooms[roomId];
    if (!room) return;
    
    const player = room.players[playerId];
    if (!player) return;
    
    if (value < 1 || value > 9) {
      console.log(`⚠️ Valeur invalide: ${value}`);
      return;
    }
    
    const initialGrid = room.initialPuzzle;
    if (initialGrid[row][col] !== 0) {
      console.log(`⚠️ Cellule fixe: [${row}][${col}]`);
      return;
    }
    
    const isCorrect = (value === player.solution[row][col]);
    
    player.grid[row][col] = value;
    
    if (isCorrect) {
      player.correctMoves++;
      player.combo++;
      
      if (room.gameMode === 'powerup' && player.combo > 0 && player.combo % 5 === 0) {
        player.energy = Math.floor(player.combo / 5);
        console.log(`⚡ ${player.playerName} ÉNERGIE +1 → Total: ${player.energy}`);
      }
    } else {
      player.errors++;
      player.combo = 0;
    }
    
    player.progress = calculateProgress(player.grid);
    
    console.log(`🎯 ${player.playerName} [${row}][${col}]=${value} → ${isCorrect ? '✅' : '❌'} | ${player.progress}/81`);
    
    resetPlayerInactivityTimer(roomId, playerId);
    
    const opponentSocketId = getOpponentSocketId(roomId, playerId);
    if (opponentSocketId) {
      io.to(opponentSocketId).emit('opponentProgress', {
        progress: player.progress,
        correctMoves: player.correctMoves,
        errors: player.errors,
        combo: player.combo,
        speed: Math.round(player.speed * 10) / 10,
        lastAction: isCorrect ? 'correct' : 'error'
      });
    }
    
    // ✅ FIN DE JEU
    if (player.progress >= 81) {
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
      
      // ✅✅✅ SAUVEGARDER LE RÉSULTAT
      finishedGames[playerId] = {
        result,
        timestamp: Date.now()
      };
      finishedGames[opponentId] = {
        result,
        timestamp: Date.now()
      };
      
      console.log(`💾 Résultat sauvegardé pour reconnexion des 2 joueurs`);
      
      io.to(player.socketId).emit('game_over', result);
      io.to(opponent.socketId).emit('game_over', result);
      
      Object.values(room.players).forEach(p => {
        if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
      });
      
      setTimeout(() => delete rooms[roomId], 5000);
    }
  });
  
  socket.on('trigger_power', (data) => {
    const { roomId, playerId } = data;
    
    const room = rooms[roomId];
    if (!room || room.gameMode !== 'powerup') return;
    
    const player = room.players[playerId];
    if (!player || player.energy < 1) return;
    
    player.energy--;
    
    resetPlayerInactivityTimer(roomId, playerId);
    
    const powers = [
      { type: 'fog', duration: 2000 },
      { type: 'flash', duration: 1000 },
      { type: 'stun', duration: 1500 },
      { type: 'shake', duration: 1500 }
    ];
    
    const randomPower = powers[Math.floor(Math.random() * powers.length)];
    const targetSelf = Math.random() < 0.40;
    
    const opponentSocketId = getOpponentSocketId(roomId, playerId);
    
    if (targetSelf) {
      console.log(`⚡ ${player.playerName} → ${randomPower.type} SUR LUI`);
      socket.emit('powerup_triggered', {
        type: randomPower.type,
        duration: randomPower.duration
      });
    } else {
      console.log(`⚡ ${player.playerName} → ${randomPower.type} SUR ADVERSAIRE`);
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

  socket.on('playerAbandoned', (data) => {
    const { roomId, playerId } = data;
    
    const room = rooms[roomId];
    if (!room) return;
    
    const abandoned = room.players[playerId];
    if (!abandoned) return;
    
    console.log(`🚪 ${abandoned.playerName} ABANDONNE`);
    
    const opponentId = Object.keys(room.players).find(id => id !== playerId);
    const opponent = room.players[opponentId];
    
    if (opponent) {
      const elapsed = (Date.now() - room.startTime) / 1000;
      const winnerScore = calculateScore(opponent, elapsed);
      
      const result = {
        winnerId: opponentId,
        winnerName: opponent.playerName,
        winnerScore,
        loserId: playerId,
        loserName: abandoned.playerName,
        loserScore: 0,
        reason: 'opponent_abandoned'
      };
      
      // ✅✅✅ SAUVEGARDER LE RÉSULTAT
      finishedGames[opponentId] = {
        result,
        timestamp: Date.now()
      };
      finishedGames[playerId] = {
        result,
        timestamp: Date.now()
      };
      
      console.log(`💾 Résultat abandon sauvegardé pour reconnexion`);
      
      io.to(opponent.socketId).emit('game_over', result);
      io.to(abandoned.socketId).emit('game_over', result);
      
      console.log(`🏆 ${opponent.playerName} gagne par abandon`);
    }
    
    Object.values(room.players).forEach(p => {
      if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
    });
    
    if (disconnectedPlayers[playerId]) {
      clearTimeout(disconnectedPlayers[playerId].timeout);
      delete disconnectedPlayers[playerId];
    }
    
    delete rooms[roomId];
  });

  socket.on('disconnect', () => {
    console.log('🔌 Déconnexion:', socket.id);
    
    for (const mode in queues) {
      for (const difficulty in queues[mode]) {
        const index = queues[mode][difficulty].findIndex(p => p.socketId === socket.id);
        if (index !== -1) {
          const player = queues[mode][difficulty].splice(index, 1)[0];
          console.log(`🚪 ${player.playerName} retiré (déco)`);
        }
      }
    }
    
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const disconnected = Object.values(room.players).find(p => p.socketId === socket.id);
      
      if (disconnected) {
        console.log(`⚠️ ${disconnected.playerName} déco - ATTENTE 60s`);
        
        disconnectedPlayers[disconnected.playerId] = {
          roomId,
          timestamp: Date.now(),
          timeout: setTimeout(() => {
            console.log(`⏰ ${disconnected.playerName} absent après 60s`);
            
            const opponentId = Object.keys(room.players).find(id => id !== disconnected.playerId);
            const opponent = room.players[opponentId];
            
            if (opponent) {
              const elapsed = (Date.now() - room.startTime) / 1000;
              const winnerScore = calculateScore(opponent, elapsed);
              
              const result = {
                winnerId: opponentId,
                winnerName: opponent.playerName,
                winnerScore,
                loserId: disconnected.playerId,
                loserName: disconnected.playerName,
                loserScore: 0,
                reason: 'opponent_abandoned'
              };
              
              // ✅✅✅ SAUVEGARDER LE RÉSULTAT
              finishedGames[opponentId] = {
                result,
                timestamp: Date.now()
              };
              finishedGames[disconnected.playerId] = {
                result,
                timestamp: Date.now()
              };
              
              console.log(`💾 Résultat timeout 60s sauvegardé pour reconnexion`);
              
              io.to(opponent.socketId).emit('game_over', result);
            }
            
            Object.values(room.players).forEach(p => {
              if (p.inactivityTimer) clearTimeout(p.inactivityTimer);
            });
            
            delete rooms[roomId];
            delete disconnectedPlayers[disconnected.playerId];
          }, RECONNECT_TIMEOUT)
        };
        
        const opponentId = Object.keys(room.players).find(id => id !== disconnected.playerId);
        const opponentSocketId = room.players[opponentId]?.socketId;
        
        if (opponentSocketId) {
          io.to(opponentSocketId).emit('opponent_disconnected_temp', {
            playerName: disconnected.playerName,
            waitTime: 60
          });
        }
        
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
    message: 'Sudoku Server v11 - FIX INACTIVITY VICTORY POPUP',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  
  let totalWaiting = 0;
  for (const mode in queues) {
    for (const difficulty in queues[mode]) {
      totalWaiting += queues[mode][difficulty].length;
    }
  }
  
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    rooms: Object.keys(rooms).length,
    queues: {
      classic: {
        easy: queues.classic.easy.length,
        medium: queues.classic.medium.length,
        hard: queues.classic.hard.length,
        expert: queues.classic.expert.length
      },
      powerup: {
        easy: queues.powerup.easy.length,
        medium: queues.powerup.medium.length,
        hard: queues.powerup.hard.length,
        expert: queues.powerup.expert.length
      },
      total: totalWaiting
    },
    connectedPlayers: Object.keys(connectedSockets).length,
    disconnectedPlayers: Object.keys(disconnectedPlayers).length,
    finishedGames: Object.keys(finishedGames).length,
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
      difficulty: rooms[id].difficulty,
      players: Object.keys(rooms[id].players).map(pid => ({
        name: rooms[id].players[pid].playerName,
        progress: rooms[id].players[pid].progress,
        combo: rooms[id].players[pid].combo,
        energy: rooms[id].players[pid].energy
      }))
    })),
    queues: {
      classic: {
        easy: queues.classic.easy.map(p => ({ name: p.playerName })),
        medium: queues.classic.medium.map(p => ({ name: p.playerName })),
        hard: queues.classic.hard.map(p => ({ name: p.playerName })),
        expert: queues.classic.expert.map(p => ({ name: p.playerName }))
      },
      powerup: {
        easy: queues.powerup.easy.map(p => ({ name: p.playerName })),
        medium: queues.powerup.medium.map(p => ({ name: p.playerName })),
        hard: queues.powerup.hard.map(p => ({ name: p.playerName })),
        expert: queues.powerup.expert.map(p => ({ name: p.playerName }))
      }
    },
    disconnectedPlayers: Object.keys(disconnectedPlayers).length,
    finishedGames: Object.keys(finishedGames).length
  });
});

setInterval(() => {
  let totalWaiting = 0;
  for (const mode in queues) {
    for (const difficulty in queues[mode]) {
      totalWaiting += queues[mode][difficulty].length;
    }
  }
  
  console.log('📊 ========== STATS ==========');
  console.log(`   Rooms: ${Object.keys(rooms).length}`);
  console.log(`   Players Waiting: ${totalWaiting}`);
  console.log(`   Connected: ${Object.keys(connectedSockets).length}`);
  console.log(`   Disconnected: ${Object.keys(disconnectedPlayers).length}`);
  console.log(`   Finished Games Cache: ${Object.keys(finishedGames).length}`);
  console.log('==============================');
}, 300000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur v11 FIX INACTIVITY VICTORY sur port ${PORT}`);
  console.log(`🌐 Health: http://localhost:${PORT}/health`);
  console.log(`📊 Stats: http://localhost:${PORT}/stats`);
});
