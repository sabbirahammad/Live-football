import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import connectDB from './db.js';
import admin from 'firebase-admin';
import fs from 'fs';
import cron from 'node-cron';
import User from './models/User.js';
import authRoutes from './routes/authRoutes.js';
import matchRoutes from './routes/matchRoutes.js';
import playerRoutes from './routes/playerRoutes.js';
import teamRoutes from './routes/teamRoutes.js';
import roomRoutes from './routes/roomRoutes.js';
import leaderboardRoutes from './routes/leaderboardRoutes.js';
import { fetchAndSaveLiveMatches } from './services/liveMatchService.js';


// Environment variables লোড করা
dotenv.config();

// MongoDB কানেক্ট করা
connectDB();

// Firebase Admin ইনিশিয়ালাইজ করা হচ্ছে
const serviceAccount = JSON.parse(fs.readFileSync('./firebase-admin-sdk.json', 'utf-8'));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();

// Socket.io সার্ভার সেটআপ
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // ফ্রন্টএন্ড থেকে রিকোয়েস্ট অ্যালাও করার জন্য
  }
});

// Controller থেকে io ব্যবহার করার জন্য app-এ সেট করা হলো
app.set('io', io);

// Middleware সেটআপ (পারফরম্যান্স এবং সিকিউরিটির জন্য)
app.use(helmet());           // HTTP security headers
app.use(cors());             // Cross-Origin Resource Sharing
app.use(express.json({ limit: '10mb' })); // বড় সাইজের Base64 Image parse করার জন্য
app.use(morgan('dev'));      // API Request log দেখার জন্য

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/leaderboard', leaderboardRoutes);

// বেসিক টেস্টিং রাউট
app.get('/', (req, res) => {
  res.send('Goal Adda API is running... ⚽');
});

// Voice Room এর মেম্বারদের রিয়েল-টাইম ডেটা স্টোর করার জন্য
const voiceRooms = {}; 
const MAX_VOICE_ROOM_USERS = 4;

// Socket.io কানেকশন লজিক
io.on("connection", (socket) => {
  console.log(`🔌 User Connected: ${socket.id}`);

  socket.on("join_room", (roomId) => {
    socket.join(roomId);
    console.log(`👤 User joined room: ${roomId}`);
  });

  socket.on("send_message", (data) => {
    // একই রুমের অন্য মেম্বারদের কাছে মেসেজ পাঠানো
    socket.to(data.room).emit("receive_message", data);
  });

  // Voice Room Join Logic
  socket.on("join_voice", ({ roomId, user }) => {
    if (!voiceRooms[roomId]) voiceRooms[roomId] = new Map();
    if (!voiceRooms[roomId].has(user._id) && voiceRooms[roomId].size >= MAX_VOICE_ROOM_USERS) {
      io.to(socket.id).emit("voice_room_full", { maxUsers: MAX_VOICE_ROOM_USERS });
      return;
    }
    user.socketId = socket.id;
    voiceRooms[roomId].set(user._id, user);
    // Notify existing users to initiate WebRTC connection
    socket.to(roomId).emit("user_joined_voice", { newUser: user });
    io.to(roomId).emit("update_voice_users", Array.from(voiceRooms[roomId].values()));
  });

  // Voice Room Leave Logic
  socket.on("leave_voice", ({ roomId, userId }) => {
    if (voiceRooms[roomId]) {
      const user = voiceRooms[roomId].get(userId);
      voiceRooms[roomId].delete(userId);
      if (user) socket.to(roomId).emit("user_left_voice", { socketId: user.socketId });
      io.to(roomId).emit("update_voice_users", Array.from(voiceRooms[roomId].values()));
      if (voiceRooms[roomId].size === 0) delete voiceRooms[roomId];
    }
  });

  // Mute/Unmute Logic
  socket.on("toggle_mute", ({ roomId, userId, isMuted }) => {
    if (voiceRooms[roomId] && voiceRooms[roomId].has(userId)) {
      const u = voiceRooms[roomId].get(userId);
      u.isMuted = isMuted;
      voiceRooms[roomId].set(userId, u);
      io.to(roomId).emit("update_voice_users", Array.from(voiceRooms[roomId].values()));
    }
  });

  // Admin Actions (Mute & Kick)
  socket.on("admin_action", ({ roomId, targetUserId, action }) => {
    if (voiceRooms[roomId] && voiceRooms[roomId].has(targetUserId)) {
      const targetUser = voiceRooms[roomId].get(targetUserId);
      if (action === "mute") {
        targetUser.isMuted = true;
        io.to(targetUser.socketId).emit("force_mute");
      } else if (action === "kick") {
        voiceRooms[roomId].delete(targetUserId);
        io.to(targetUser.socketId).emit("force_kick");
      }
      io.to(roomId).emit("update_voice_users", Array.from(voiceRooms[roomId].values()));
      if (voiceRooms[roomId].size === 0) delete voiceRooms[roomId];
    }
  });

  // WebRTC Signaling Events
  socket.on("webrtc_offer", ({ targetSocketId, offer, senderSocketId, senderId }) => {
    io.to(targetSocketId).emit("webrtc_offer", { offer, senderSocketId, senderId });
  });

  socket.on("webrtc_answer", ({ targetSocketId, answer, senderSocketId }) => {
    io.to(targetSocketId).emit("webrtc_answer", { answer, senderSocketId });
  });

  socket.on("webrtc_ice_candidate", ({ targetSocketId, candidate, senderSocketId }) => {
    io.to(targetSocketId).emit("webrtc_ice_candidate", { candidate, senderSocketId });
  });

  socket.on("disconnect", () => {
    for (const roomId in voiceRooms) {
      for (const [userId, user] of voiceRooms[roomId].entries()) {
        if (user.socketId === socket.id) {
          voiceRooms[roomId].delete(userId);
          socket.to(roomId).emit("user_left_voice", { socketId: user.socketId });
          io.to(roomId).emit("update_voice_users", Array.from(voiceRooms[roomId].values()));
          if (voiceRooms[roomId].size === 0) delete voiceRooms[roomId];
        }
      }
    }
    console.log("❌ User Disconnected", socket.id);
  });
});

// Auto-fetch live matches every 15 minutes to stay within 100 requests/day limit
// 15 mins = 15 * 60 * 1000 = 900000 ms
// ⚠️ DEVELOPMENT-এর জন্য এটি কমেন্ট করে রাখা হলো, যেন API Limit শেষ না হয়
const shouldAutoSyncMatches = process.env.ENABLE_MATCH_SYNC !== 'false' && !!process.env.FOOTBALL_API_KEY;

if (shouldAutoSyncMatches) {
  setInterval(() => {
    fetchAndSaveLiveMatches(io);
  }, 900000);

  fetchAndSaveLiveMatches(io);
} else {
  console.log('Match auto-sync disabled. Set FOOTBALL_API_KEY and keep ENABLE_MATCH_SYNC not false to enable it.');
}

// ⏰ Weekly Leaderboard Cron Job (প্রতি রবিবার রাত ১২ টায় চলবে)
cron.schedule('0 0 * * 0', async () => {
  console.log('⏳ Running Weekly Leaderboard Cron Job...');
  try {
    // নতুন সপ্তাহের জন্য সবার weeklyPoints জিরো করে দেওয়া হচ্ছে
    await User.updateMany({}, { $set: { weeklyPoints: 0 } });
    console.log('✅ Weekly points reset successfully for the new week!');
    
    // রিয়েল-টাইম আপডেটের জন্য চাইলে Socket.io দিয়ে ফ্রন্টএন্ডে মেসেজও পাঠাতে পারেন
  } catch (error) {
    console.error('❌ Error resetting weekly points:', error);
  }
}, {
  timezone: "Asia/Dhaka" // 🇧🇩 বাংলাদেশ সময় অনুযায়ী ঠিক রাত ১২টায় রান করবে
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running in ${process.env.NODE_ENV} mode on port ${PORT}`));
