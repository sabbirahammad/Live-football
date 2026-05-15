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
  reward: { type: String, default: 'Bragging Rights' },
}, { timestamps: true });

const Room = mongoose.model('Room', roomSchema);

export default Room;