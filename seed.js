import mongoose from 'mongoose';
import dotenv from 'dotenv';
import connectDB from './db.js';
import Match from './models/Match.js';
import Player from './models/Player.js';

dotenv.config();

const matches = [
  { homeTeam: "Barcelona", awayTeam: "Real Madrid", homeScore: 1, awayScore: 1, status: "Live", matchTime: new Date(), league: "La Liga", minute: "72'", roomsCount: 142 },
  { homeTeam: "PSG", awayTeam: "Bayern Munich", homeScore: 2, awayScore: 0, status: "Live", matchTime: new Date(), league: "UCL", minute: "58'", roomsCount: 98 },
  { homeTeam: "Argentina", awayTeam: "Brazil", homeScore: 0, awayScore: 0, status: "Upcoming", matchTime: new Date(Date.now() + 86400000), league: "International", roomsCount: 67 },
  { homeTeam: "Man City", awayTeam: "Liverpool", homeScore: 0, awayScore: 0, status: "Upcoming", matchTime: new Date(Date.now() + 172800000), league: "Premier League", roomsCount: 88 },
  { homeTeam: "Chelsea", awayTeam: "Arsenal", homeScore: 0, awayScore: 0, status: "Upcoming", matchTime: new Date(Date.now() + 259200000), league: "Premier League", roomsCount: 72 },
];

const players = [
  { name: "Ter Stegen", pos: "GK", team: "Barcelona", teamColor: "#A50044", price: 9.5, pts: 45, form: [8, 6, 10, 7, 9], sel: 72, img: "TS" },
  { name: "Jules Koundé", pos: "DEF", team: "Barcelona", teamColor: "#A50044", price: 7.5, pts: 38, form: [6, 5, 8, 4, 7], sel: 45, img: "JK" },
  { name: "Ronald Araújo", pos: "DEF", team: "Barcelona", teamColor: "#A50044", price: 8.0, pts: 41, form: [7, 8, 6, 9, 5], sel: 58, img: "RA" },
  { name: "Gavi", pos: "MID", team: "Barcelona", teamColor: "#A50044", price: 9.0, pts: 62, form: [9, 11, 8, 12, 10], sel: 81, img: "GV" },
  { name: "Pedri", pos: "MID", team: "Barcelona", teamColor: "#A50044", price: 9.5, pts: 68, form: [12, 10, 9, 11, 13], sel: 88, img: "PD" },
  { name: "Frenkie de Jong", pos: "MID", team: "Barcelona", teamColor: "#A50044", price: 8.5, pts: 55, form: [8, 9, 7, 10, 8], sel: 65, img: "FD" },
  { name: "Lamine Yamal", pos: "FWD", team: "Barcelona", teamColor: "#A50044", price: 11.0, pts: 89, form: [14, 12, 16, 10, 18], sel: 94, img: "LY" },
  { name: "Robert Lewandowski", pos: "FWD", team: "Barcelona", teamColor: "#A50044", price: 12.0, pts: 95, form: [16, 14, 18, 12, 15], sel: 91, img: "RL" },
  { name: "Raphinha", pos: "FWD", team: "Barcelona", teamColor: "#A50044", price: 9.0, pts: 72, form: [10, 13, 8, 14, 11], sel: 77, img: "RP" },
  { name: "Courtois", pos: "GK", team: "Real Madrid", teamColor: "#00529F", price: 9.0, pts: 48, form: [9, 7, 11, 8, 6], sel: 69, img: "CT" },
  { name: "Carvajal", pos: "DEF", team: "Real Madrid", teamColor: "#00529F", price: 7.0, pts: 36, form: [5, 7, 6, 8, 4], sel: 42, img: "CV" },
  { name: "Rüdiger", pos: "DEF", team: "Real Madrid", teamColor: "#00529F", price: 7.5, pts: 39, form: [6, 8, 7, 5, 9], sel: 51, img: "RD" },
  { name: "Valverde", pos: "MID", team: "Real Madrid", teamColor: "#00529F", price: 9.5, pts: 71, form: [11, 13, 10, 12, 9], sel: 85, img: "VV" },
  { name: "Jude Bellingham", pos: "MID", team: "Real Madrid", teamColor: "#00529F", price: 12.0, pts: 92, form: [15, 13, 16, 11, 18], sel: 92, img: "JB" },
  { name: "Tchouaméni", pos: "MID", team: "Real Madrid", teamColor: "#00529F", price: 8.0, pts: 52, form: [7, 9, 8, 10, 7], sel: 60, img: "TC" },
  { name: "Vinicius Jr", pos: "FWD", team: "Real Madrid", teamColor: "#00529F", price: 12.5, pts: 98, form: [18, 15, 20, 13, 16], sel: 96, img: "VJ" },
  { name: "Kylian Mbappé", pos: "FWD", team: "Real Madrid", teamColor: "#00529F", price: 13.0, pts: 102, form: [20, 16, 18, 22, 15], sel: 89, img: "KM" },
  { name: "Rodrygo", pos: "FWD", team: "Real Madrid", teamColor: "#00529F", price: 9.5, pts: 74, form: [11, 10, 14, 12, 13], sel: 74, img: "RG" },
];

const importData = async () => {
  try {
    await connectDB();
    
    await Match.deleteMany(); // আগের ডেটা ক্লিয়ার করা
    await Player.deleteMany();

    await Match.insertMany(matches);
    await Player.insertMany(players);

    console.log('✅ Matches and Players imported successfully!');
    process.exit();
  } catch (error) {
    console.error(`❌ Error importing data: ${error.message}`);
    process.exit(1);
  }
};

importData();