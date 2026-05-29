import mongoose from 'mongoose';

const manualStreamSchema = new mongoose.Schema({
  matchId: {
    type: String,
    required: true,
    index: true
  },
  streamUrl: {
    type: String,
    required: true
  },
  quality: {
    type: String,
    default: 'Auto' // e.g., '1080p', '720p', 'SD'
  },
  language: {
    type: String,
    default: 'English' // e.g., 'Bengali', 'Arabic'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isBest: {
    type: Boolean,
    default: false // যদি true হয়, তবে অ্যাপে এটি "Play Best Stream" হিসেবে দেখাবে
  }
}, { timestamps: true });

export default mongoose.model('ManualStream', manualStreamSchema);