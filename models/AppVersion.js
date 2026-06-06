import mongoose from 'mongoose';

const appVersionSchema = new mongoose.Schema({
  version: { type: String, required: true },
  platform: { type: String, required: true, enum: ['android', 'ios'] },
  releaseNotes: { type: String },
  fileUrl: { type: String, required: true },
  fileName: { type: String, required: true },
  downloadCount: { type: Number, default: 0 }
}, { timestamps: true });

const AppVersion = mongoose.model('AppVersion', appVersionSchema);
export default AppVersion;