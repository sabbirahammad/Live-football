import mongoose from 'mongoose';

const playerSchema = new mongoose.Schema({
  apiId: { type: Number, unique: true, sparse: true },
  name: { type: String, required: true },
  pos: { type: String, required: true, enum: ['GK', 'DEF', 'MID', 'FWD'] },
  team: { type: String, required: true },
  teamApiId: { type: Number },
  teamColor: { type: String, default: '#FFFFFF' },
  price: { type: Number, required: true, default: 7.5 },
  pts: { type: Number, default: 0 },
  form: { type: [Number], default: [] },

 
 
}, { timestamps: true });

const Player = mongoose.model('Player', playerSchema);

export default Player;