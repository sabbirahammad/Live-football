import mongoose from 'mongoose';

const streamDomainHealthSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, unique: true, index: true },
    successCount: { type: Number, default: 0 },
    failureCount: { type: Number, default: 0 },
    consecutiveFailures: { type: Number, default: 0 },
    avgLatencyMs: { type: Number, default: 0 },
    healthScore: { type: Number, default: 0 },
    lastCheckedAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastFailureAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const StreamDomainHealth = mongoose.model('StreamDomainHealth', streamDomainHealthSchema);

export default StreamDomainHealth;
