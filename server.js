// server.js
const express = require('express');
const { Server } = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Data utama
let scoreboardData = {
  player1Name: "PLAYER 1",
  player2Name: "PLAYER 2",
  matchInfo: "CLASS - CATEGORY",
  matchId: "1001",
  roundNumber: "ROUND 1",
  initialDuration: 120,
  duration: 120,
  timerRunning: false,
  gamJeom1: 0,
  gamJeom2: 0,
  score1: 0,
  score2: 0,
  roundWins1: 0,
  roundWins2: 0,
  hits1: 0,   // Jumlah klik juri untuk Player 1
  hits2: 0,   // Jumlah klik juri untuk Player 2
  winner: null,
  roundEnded: false
};

// Riwayat penilaian juri (untuk konsensus)
// Tambahkan flag `consumed` untuk menandai vote yang sudah dipakai
// dalam sebuah konsensus sehingga tidak dihitung ulang ketika
// juri ketiga mengonfirmasi yang sama.
const judgeHistory = {
  judge1: { player: null, points: null, timestamp: 0, consumed: false },
  judge2: { player: null, points: null, timestamp: 0, consumed: false },
  judge3: { player: null, points: null, timestamp: 0, consumed: false }
};

let timerInterval = null;

// REST TIMER state (shared)
let restTimerInterval = null;
let restRemaining = 0;
let restIsRunning = false;

// Serve file statis
app.use(express.static(__dirname));

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);
  socket.emit('scoreboard-update', scoreboardData);

  // Update data umum dari control.html
  socket.on('update-scoreboard', (data) => {
    if (data.player1Name !== undefined) scoreboardData.player1Name = data.player1Name.toUpperCase().trim();
    if (data.player2Name !== undefined) scoreboardData.player2Name = data.player2Name.toUpperCase().trim();
    if (data.matchInfo !== undefined) scoreboardData.matchInfo = data.matchInfo.trim();
    if (data.matchId !== undefined) scoreboardData.matchId = data.matchId.trim();
    if (data.roundNumber !== undefined) scoreboardData.roundNumber = data.roundNumber;

    if (data.duration !== undefined) {
      scoreboardData.initialDuration = data.duration;
      scoreboardData.duration = data.duration;
    }

    // Reset status saat ganti pertandingan
    scoreboardData.winner = null;
    scoreboardData.roundEnded = false;
    io.emit('scoreboard-update', scoreboardData);
  });

  // Kontrol timer
  socket.on('timer-control', (action) => {
    if (action === 'start') {
      if (scoreboardData.winner || scoreboardData.roundEnded) return;
      if (!scoreboardData.timerRunning && scoreboardData.duration > 0) {
        scoreboardData.timerRunning = true;
        clearInterval(timerInterval);

        timerInterval = setInterval(() => {
          if (scoreboardData.duration > 0) {
            scoreboardData.duration--;
            io.emit('scoreboard-update', scoreboardData);
            checkVictoryByPointsGap(); // Cek selisih tiap detik
          } else {
            scoreboardData.timerRunning = false;
            clearInterval(timerInterval);
            endRoundAutomatically();
          }
        }, 1000);

        io.emit('timer-control', 'start');
      }
    } else if (action === 'pause') {
      scoreboardData.timerRunning = false;
      clearInterval(timerInterval);
      io.emit('timer-control', 'pause');
    } else if (action === 'reset') {
      scoreboardData.timerRunning = false;
      clearInterval(timerInterval);
      scoreboardData.duration = scoreboardData.initialDuration;
      scoreboardData.winner = null;
      scoreboardData.roundEnded = false;
      io.emit('scoreboard-update', scoreboardData);
      io.emit('timer-control', 'pause');
    }
  });

  // Tambah/kurangi skor dari control
  socket.on('adjust-score', (payload) => {
    // payload: { player: 'player1'|'player2', amount: number }
    try {
      const player = payload && payload.player;
      const amount = payload && Number(payload.amount) || 0;
      // Use the main scoreboardData object directly
      applyScoreChange(scoreboardData, io, player, amount);
    } catch (err) {
      console.error('adjust-score error', err);
    }
  });

  // Penalti Gam-Jeom
  socket.on('add-gam-jeom', (player) => {
    if (player === 'player1' && scoreboardData.gamJeom1 < 5) {
      scoreboardData.gamJeom1++;
      scoreboardData.score2++;

      if (scoreboardData.gamJeom1 >= 5 && !scoreboardData.roundEnded) {
        endRoundByDisqualification('player2');
      }
    } else if (player === 'player2' && scoreboardData.gamJeom2 < 5) {
      scoreboardData.gamJeom2++;
      scoreboardData.score1++;

      if (scoreboardData.gamJeom2 >= 5 && !scoreboardData.roundEnded) {
        endRoundByDisqualification('player1');
      }
    }

    if (!scoreboardData.roundEnded) {
      io.emit('scoreboard-update', scoreboardData);
      checkVictoryByPointsGap();
    }
  });

  // Skor dari juri (konsensus)
  socket.on('judge-score', (data) => {
    const { judge, player, points } = data;
    if (!['judge1', 'judge2', 'judge3'].includes(judge)) return;

    const now = Date.now();
    // Simpan vote terbaru sebagai tidak-terpakai (consumed = false)
    judgeHistory[judge] = { player, points, timestamp: now, consumed: false };

    // Kumpulkan daftar juri yang memiliki vote matching dan belum consumed
    const matchedJudges = [];
    for (const j of Object.keys(judgeHistory)) {
      const entry = judgeHistory[j];
      const timeDiff = now - entry.timestamp;
      if (!entry.consumed && timeDiff <= 5000 && entry.player === player && entry.points === points) {
        matchedJudges.push(j);
      }
    }

    // Jika ada minimal 2 juri yang cocok (dan belum dipakai), berikan poin ONCE
    if (matchedJudges.length >= 2) {
      if (player === 'player1') {
        scoreboardData.score1 += points;
      } else if (player === 'player2') {
        scoreboardData.score2 += points;
      }

      // Tandai semua vote yang dipakai sebagai consumed agar tidak dipakai lagi
      for (const j of matchedJudges) {
        judgeHistory[j].consumed = true;
      }

      io.emit('scoreboard-update', scoreboardData);
      checkVictoryByPointsGap();
    }

    // ✅ SELALU tambah HITS, terlepas dari konsensus
    if (player === 'player1') {
      scoreboardData.hits1++;
    } else if (player === 'player2') {
      scoreboardData.hits2++;
    }

    io.emit('scoreboard-update', scoreboardData);

    socket.emit('judge-feedback', { consensus: matchedJudges.length >= 2, player, points });
  });

  // Penentuan pemenang manual
  socket.on('force-winner', (winner) => {
    if (scoreboardData.roundEnded) return;

    scoreboardData.roundEnded = true;
    scoreboardData.timerRunning = false;
    clearInterval(timerInterval);

    if (winner === 'player1') {
      scoreboardData.winner = 'player1';
      scoreboardData.roundWins1++;
    } else if (winner === 'player2') {
      scoreboardData.winner = 'player2';
      scoreboardData.roundWins2++;
    } else if (winner === 'draw') {
      scoreboardData.winner = 'draw';
    }

    io.emit('scoreboard-update', scoreboardData);
    io.emit('timer-control', 'pause');
  });

  // Reset skor & penalti
  socket.on('reset-scores', () => {
    scoreboardData.score1 = 0;
    scoreboardData.score2 = 0;
    scoreboardData.gamJeom1 = 0;
    scoreboardData.gamJeom2 = 0;
    scoreboardData.hits1 = 0;
    scoreboardData.hits2 = 0;
    scoreboardData.winner = null;
    scoreboardData.roundEnded = false;
    scoreboardData.timerRunning = false;
    clearInterval(timerInterval);
    io.emit('scoreboard-update', scoreboardData);
    io.emit('timer-control', 'pause');
  });

  // Reset jumlah kemenangan ronde
  socket.on('reset-round-wins', () => {
    scoreboardData.roundWins1 = 0;
    scoreboardData.roundWins2 = 0;
    io.emit('scoreboard-update', scoreboardData);
  });

  // Ensure main timer actions stop rest timer
  socket.on('timer-control', (action) => {
    // existing main timer handling happens elsewhere; additionally stop rest timer
    if (restTimerInterval) {
      clearInterval(restTimerInterval);
      restTimerInterval = null;
      restIsRunning = false;
      // notify clients rest timer reset
      io.emit('rest-timer-control', 'reset');
      io.emit('rest-timer-tick', restRemaining);
    }
  });

  socket.on('rest-timer-control', (payload) => {
    const action = (payload && typeof payload === 'object') ? payload.action : payload;
    const duration = (payload && typeof payload.duration === 'number') ? payload.duration : null;

    if (action === 'start') {
      if (duration !== null) restRemaining = duration;
      if (restTimerInterval) clearInterval(restTimerInterval);
      restIsRunning = true;
      io.emit('rest-timer-control', 'start');
      io.emit('rest-timer-tick', restRemaining);

      restTimerInterval = setInterval(() => {
        restRemaining = Math.max(0, restRemaining - 1);
        io.emit('rest-timer-tick', restRemaining);
        if (restRemaining <= 0) {
          clearInterval(restTimerInterval);
          restTimerInterval = null;
          restIsRunning = false;
          // notify reset/finished
          io.emit('rest-timer-control', 'reset');
        }
      }, 1000);

    } else if (action === 'pause') {
      if (restTimerInterval) {
        clearInterval(restTimerInterval);
        restTimerInterval = null;
      }
      restIsRunning = false;
      io.emit('rest-timer-control', 'pause');

    } else if (action === 'reset') {
      if (restTimerInterval) {
        clearInterval(restTimerInterval);
        restTimerInterval = null;
      }
      restIsRunning = false;
      if (duration !== null) restRemaining = duration;
      io.emit('rest-timer-tick', restRemaining);
      io.emit('rest-timer-control', 'reset');
    }
  });

  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.id);
  });
});

// Helper: apply score change with max cap and auto-win at 24
function applyScoreChange(state, io, player, amount) {
  if (!state) return;
  const key = player === 'player1' ? 'score1' : 'score2';
  state[key] = (state[key] || 0) + Number(amount || 0);
  // clamp between 0 and 24
  if (state[key] < 0) state[key] = 0;
  if (state[key] > 24) state[key] = 24;

  // Broadcast updated scoreboard
  io.emit('scoreboard-update', state);

  // If reached max, declare winner once and finalize round server-side
  if (state[key] >= 24 && !state.roundEnded) {
    state.roundEnded = true;
    state.timerRunning = false;
    clearInterval(timerInterval);

    state.winner = player;
    if (player === 'player1') {
      state.roundWins1 = (state.roundWins1 || 0) + 1;
    } else if (player === 'player2') {
      state.roundWins2 = (state.roundWins2 || 0) + 1;
    }

    io.emit('scoreboard-update', state);
    io.emit('timer-control', 'pause');
    io.emit('rest-timer-control', 'reset');
  }
}

// Cek kemenangan karena selisih skor ≥12
function checkVictoryByPointsGap() {
  if (scoreboardData.roundEnded) return;

  const diff = Math.abs(scoreboardData.score1 - scoreboardData.score2);
  if (diff >= 12) {
    scoreboardData.roundEnded = true;
    scoreboardData.timerRunning = false;
    clearInterval(timerInterval);

    if (scoreboardData.score1 > scoreboardData.score2) {
      scoreboardData.winner = 'player1';
      scoreboardData.roundWins1++;
    } else {
      scoreboardData.winner = 'player2';
      scoreboardData.roundWins2++;
    }

    io.emit('scoreboard-update', scoreboardData);
    io.emit('timer-control', 'pause');
  }
}

// Akhiri ronde saat waktu habis
function endRoundAutomatically() {
  if (scoreboardData.roundEnded) return;

  scoreboardData.roundEnded = true;
  scoreboardData.timerRunning = false;
  clearInterval(timerInterval);

  if (scoreboardData.score1 > scoreboardData.score2) {
    scoreboardData.winner = 'player1';
    scoreboardData.roundWins1++;
  } else if (scoreboardData.score2 > scoreboardData.score1) {
    scoreboardData.winner = 'player2';
    scoreboardData.roundWins2++;
  } else {
    scoreboardData.winner = 'draw';
  }

  io.emit('scoreboard-update', scoreboardData);
}

// Diskualifikasi karena Gam-Jeom = 5
function endRoundByDisqualification(winnerPlayer) {
  scoreboardData.roundEnded = true;
  scoreboardData.timerRunning = false;
  clearInterval(timerInterval);

  scoreboardData.winner = winnerPlayer;
  if (winnerPlayer === 'player1') {
    scoreboardData.roundWins1++;
  } else {
    scoreboardData.roundWins2++;
  }

  io.emit('scoreboard-update', scoreboardData);
}

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`==================================================`);
  console.log(`   🥋 Taekwondo Scoreboard Berjalan`);
  console.log(`   Akses: http://<IP-ANDA>:${PORT}/display.html`);
  console.log(`   Kontrol: http://<IP-ANDA>:${PORT}/control.html`);
  console.log(`   Juri 1: http://<IP-ANDA>:${PORT}/judge1.html`);
  console.log(`   Juri 2: http://<IP-ANDA>:${PORT}/judge2.html`);
  console.log(`   Juri 3: http://<IP-ANDA>:${PORT}/judge3.html`);
  console.log(`==================================================`);
});