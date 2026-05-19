import mongoose from 'mongoose';

const streamItemSchema = new mongoose.Schema(
  {
    title: { type: String, default: 'Live Stream' },
    url: { type: String, required: true },
    source: { type: String, default: 'iptv-scraper' },
    rankScore: { type: Number, default: 0 },
    healthScore: { type: Number, default: 0 },
    latencyMs: { type: Number, default: null },
    isValidated: { type: Boolean, default: false },
    isAlive: { type: Boolean, default: null },
    checkedAt: { type: Date, default: null },
    domain: { type: String, default: '' },
  },
  { _id: false }
);

const streamErrorSchema = new mongoose.Schema(
  {
    searchTerm: { type: String, default: '' },
    message: { type: String, default: '' },
  },
  { _id: false }
);

const streamDiagnosticsSchema = new mongoose.Schema(
  {
    skipped: { type: Boolean, default: false },
    reason: { type: String, default: '' },
    attemptedTerms: [{ type: String }],
    durationMs: { type: Number, default: 0 },
    priorityMatch: { type: Boolean, default: false },
    prefetchedAt: { type: Date },
    validation: {
      checkedCount: { type: Number, default: 0 },
      aliveCount: { type: Number, default: 0 },
      failedCount: { type: Number, default: 0 },
    },
  },
  { _id: false }
);

const streamCacheSchema = new mongoose.Schema(
  {
    fixtureKey: { type: String, required: true, unique: true, index: true },
    fixtureId: { type: Number, default: null },
    matchId: { type: String, default: '' },
    matchLabel: { type: String, required: true },
    status: { type: String, default: 'Upcoming' },
    league: { type: String, default: '' },
    available: { type: Boolean, default: false },
    source: { type: String, default: 'iptv-scraper' },
    searchedTerms: [{ type: String }],
    matchedSearchTerm: { type: String, default: null },
    streams: [streamItemSchema],
    streamCount: { type: Number, default: 0 },
    state: { type: String, default: 'empty' },
    cachedAt: { type: Date, default: Date.now },
    runtime: { type: String, default: null },
    errors: [streamErrorSchema],
    diagnostics: { type: streamDiagnosticsSchema, default: () => ({}) },
    message: { type: String, default: '' },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true }
);

streamCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const StreamCache = mongoose.model('StreamCache', streamCacheSchema);

export default StreamCache;
