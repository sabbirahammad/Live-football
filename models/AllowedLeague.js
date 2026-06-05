import mongoose from 'mongoose';

const allowedLeagueSchema = new mongoose.Schema({
  leagueId: {
    type: Number,
    required: true,
    unique: true,
  },
  name: {
    type: String,
    required: true,
  },
  addedAt: {
    type: Date,
    default: Date.now,
  },
});

export default mongoose.model('AllowedLeague', allowedLeagueSchema);