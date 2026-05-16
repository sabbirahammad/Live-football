import mongoose from 'mongoose';

const fantasyTeamSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  match: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', required: true },
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }],
  captain: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
  viceCaptain: { type: mongoose.Schema.Types.ObjectId, ref: 'Player', required: true },
  totalPoints: { type: Number, default: 0 },
  awardedPoints: { type: Number, default: 0 },
  playerPoints: { type: Map, of: Number, default: {} }
}, { timestamps: true });

const FantasyTeam = mongoose.model('FantasyTeam', fantasyTeamSchema);

export default FantasyTeam;
