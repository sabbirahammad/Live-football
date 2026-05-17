import mongoose from 'mongoose';

const matchSchema = new mongoose.Schema({
  homeTeam: { type: String, required: true },
  awayTeam: { type: String, required: true },
  homeLogo: { type: String, default: '' },
  awayLogo: { type: String, default: '' },
  homeTeamApiId: { type: Number },
  awayTeamApiId: { type: Number },
  homeScore: { type: Number, default: 0 },
  awayScore: { type: Number, default: 0 },
  status: { type: String, enum: ['Upcoming', 'Live', 'Finished'], default: 'Upcoming' },
  matchTime: { type: Date, required: true },
  league: { type: String, required: true },
  minute: { type: String, default: "0'" }, // Live ম্যাচের সময় (যেমন: 72')
  roomsCount: { type: Number, default: 0 }, // এই ম্যাচের আন্ডারে কয়টি ফ্যান্টাসি রুম খোলা হয়েছে
  fixtureId: { type: Number }, // From API-Football
  players: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Player' }] // Players in this match
}, { timestamps: true });

const Match = mongoose.model('Match', matchSchema);

export default Match;
