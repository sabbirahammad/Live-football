import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import AppVersion from '../models/AppVersion.js';

const router = express.Router();

// ফাইল স্টোরেজ কনফিগারেশন
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = './uploads/apps';
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // সর্বোচ্চ ১০০ এমবি
});

// ১. এডমিন থেকে অ্যাপ আপলোড (POST)
router.post('/upload-app', upload.single('appFile'), async (req, res) => {
  try {
    const { version, releaseNotes, platform } = req.body;
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/apps/${req.file.filename}`;

    const newUpdate = new AppVersion({
      version,
      platform,
      releaseNotes,
      fileUrl,
      fileName: req.file.filename
    });

    await newUpdate.save();

    // Socket.io এর মাধ্যমে সব ইউজারকে নোটিফাই করা
    const io = req.app.get('io');
    if (io) {
      io.emit('app_update_available', {
        version,
        platform,
        releaseNotes,
        fileUrl
      });
    }

    res.status(201).json({ message: 'App version updated successfully', data: newUpdate });
  } catch (error) {
    console.error('Error during app upload:', error);
    res.status(500).json({ message: error.message });
  }
});

// ২. ওয়েবসাইট থেকে লেটেস্ট অ্যাপ এর তথ্য পাওয়া (GET)
router.get('/latest-app/:platform', async (req, res) => {
  try {
    const { platform } = req.params;
    const latest = await AppVersion.findOne({ platform }).sort({ createdAt: -1 });
    if (!latest) return res.status(404).json({ message: 'No update found' });
    
    res.json(latest);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

export default router;