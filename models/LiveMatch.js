import mongoose from 'mongoose';

const matchSchema = new mongoose.Schema({
  fixtureId: { type: Number, required: true, unique: true },
  league: Object,
  teams: Object,
  goals: Object,
  fixture: Object,
  score: Object,
  events: Array,
  lastUpdated: { type: Date, default: Date.now }
});

export default mongoose.model('LiveMatch', matchSchema);