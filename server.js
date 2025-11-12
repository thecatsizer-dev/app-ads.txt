import { Server } from 'socket.io';
import { createServer } from 'http';

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

let waitingPlayers = [];
const activeRooms = new Map();

console.log('🚀 Sudoku Multiplayer Server starting...');

io.on('connection', (socket) => {
  console.log('🎮 Player connected:', socket.id);

  // 🔍 MATCHMAKING
  socket.on('joinQueue', (data) => {
    const { playerId, playerName } = data;
    console.log(`📥 ${playerName} (${playerId}) joined queue`);

    // Ajouter à la file d'attente
    waitingPlayers.push({ socket, playerId, playerName });
    console.log(`📊 Queue size: ${waitingPlayers.length}`);

    // Si 2+ joueurs en attente, créer une room
    if (waitingPlayers.length >= 2) {
      const [p1, p2] = waitingPlayers.splice(0, 2);
      const roomId = `room_${Date.now()}`;

      p1.socket.join(roomId);
      p2.socket.join(roomId);

      activeRooms.set(roomId, {
        player1: { id: p1.playerId, name: p1.playerName, progress: 0 },
        player2: { id: p2.playerId, name: p2.playerName, progress: 0 },
        startTime: Date.now()
      });

      // Informer les deux joueurs
      p1.socket.emit('matchFound', {
        roomId,
        opponentId: p2.playerId,
        opponentName: p2.playerName
      });

      p2.socket.emit('matchFound', {
        roomId,
        opponentId: p1.playerId,
        opponentName: p1.playerName
      });

      console.log(`✅ Match créé: ${roomId}`);
      console.log(`   ${p1.playerName} vs ${p2.playerName}`);
    } else {
      socket.emit('waiting');
    }
  });

  // 📊 MISE À JOUR PROGRESSION
  socket.on('updateProgress', (data) => {
    const { roomId, playerId, progress } = data;
    
    if (activeRooms.has(roomId)) {
      const room = activeRooms.get(roomId);
      
      // Mettre à jour la progression
      if (room.player1.id === playerId) {
        room.player1.progress = progress;
      } else if (room.player2.id === playerId) {
        room.player2.progress = progress;
      }

      // Envoyer à l'adversaire
      socket.to(roomId).emit('opponentProgress', { progress });

      console.log(`📊 ${roomId}: P1=${room.player1.progress}, P2=${room.player2.progress}`);
    }
  });

  // 🏆 FIN DE PARTIE
  socket.on('gameEnd', (data) => {
    const { roomId, playerId, score, timeInSeconds } = data;
    
    if (activeRooms.has(roomId)) {
      // Informer l'adversaire
      socket.to(roomId).emit('opponentFinished', {
        winnerId: playerId,
        score,
        timeInSeconds
      });

      console.log(`🏁 Game ended in ${roomId} by ${playerId}`);
      console.log(`   Score: ${score}, Time: ${timeInSeconds}s`);
      
      // Nettoyer la room après 30 secondes
      setTimeout(() => {
        activeRooms.delete(roomId);
        console.log(`🧹 Room ${roomId} cleaned up`);
      }, 30000);
    }
  });

  // 🚪 ABANDON
  socket.on('leaveQueue', () => {
    waitingPlayers = waitingPlayers.filter(p => p.socket.id !== socket.id);
    console.log('❌ Player left queue:', socket.id);
  });

  // 🔌 DÉCONNEXION
  socket.on('disconnect', () => {
    waitingPlayers = waitingPlayers.filter(p => p.socket.id !== socket.id);
    
    // Notifier l'adversaire si en partie
    for (const [roomId, room] of activeRooms.entries()) {
      const isPlayer1 = room.player1.id === socket.id;
      const isPlayer2 = room.player2.id === socket.id;
      
      if (isPlayer1 || isPlayer2) {
        socket.to(roomId).emit('opponentDisconnected');
        activeRooms.delete(roomId);
        console.log(`⚠️ Player disconnected from ${roomId}`);
      }
    }

    console.log('👋 Player disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 WebSocket ready for connections`);
});
```

**`server/.gitignore`** (optionnel mais recommandé)
```
node_modules/
.env
*.log