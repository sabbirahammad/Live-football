import connectDB from './db.js';
import Match from './models/Match.js';
import dotenv from 'dotenv';
dotenv.config();

connectDB().then(async () => {
    const docs = await Match.find({ fixtureId: null });
    console.log("Docs with fixtureId: null ->", docs.length);
    const docs2 = await Match.find({ fixtureId: { $exists: false } });
    console.log("Docs with fixtureId missing ->", docs2.length);
    const all = await Match.find({});
    console.log("All docs ->", all.map(m => ({home: m.homeTeam, away: m.awayTeam, fixtureId: m.fixtureId})));
    process.exit(0);
});
