import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
  name: { type: String, required: true },
  code: { type: String, required: true, unique: true },
  match: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', required: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  privacy: { type: String, enum: ['Public', 'Private'], default: 'Public' },
  members: [
    {
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      team: { type: mongoose.Schema.Types.ObjectId, ref: 'FantasyTeam' },
    }
  ],
  maxMembers: { type: Number, default: 50 },
  maxPlayers: { type: Number, default: 10 },
  challengeType: { type: String, default: 'public' },
  entryFeeAmount: { type: Number, default: 0 },
  entryFeeCurrency: { type: String, enum: ['none', 'coins', 'jersey'], default: 'none' },
  prizePool: { type: Number, default: 0 },
  prizeDistribution: { type: Map, of: Number, default: { '1st': 0.5, '2nd': 0.3, '3rd': 0.2 } }, // Default 50/30/20
  reward: { type: String, default: 'Bragging Rights' },
}, { timestamps: true });

const Room = mongoose.model('Room', roomSchema);

export default Room;