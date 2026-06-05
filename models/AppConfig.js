import mongoose from 'mongoose';

const appConfigSchema = new mongoose.Schema({
  latestVersion: { type: String, required: true, default: '1.0.0' },
  updateUrl: { type: String, required: true, default: 'https://elitepassit.com/' },
  forceUpdate: { type: Boolean, default: false },
  updateMessage: { type: String, default: 'অ্যাপের নতুন আপডেট এসেছে। ভালো পারফরম্যান্স পেতে এখনই আপডেট করে নিন!' }
}, { timestamps: true });

const AppConfig = mongoose.model('AppConfig', appConfigSchema);
export default AppConfig;