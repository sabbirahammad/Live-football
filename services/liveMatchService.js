import axios from 'axios';
import LiveMatch from '../models/LiveMatch.js';
import Match from '../models/Match.js';
import Player from '../models/Player.js';
import FantasyTeam from '../models/FantasyTeam.js';
import Room from '../models/Room.js';
import { processAutoSubsAndRewards } from '../controllers/matchController.js';

const LIVE_SHORT_CODES = ['1H', '2H', 'HT', 'ET', 'P', 'LIVE'];
const FINISHED_SHORT_CODES = ['FT', 'AET', 'PEN'];
const TOP_LEAGUE_IDS = [2, 3, 4, 9, 15, 39, 61, 66, 78, 135, 140];

const LIVE_POINT_RULES = {
  Goal: 10,
  CardYellow: -2,
  CardRed: -5,
  VarRed: -5,
  PenaltyMissed: -3,
};

const getTeamPlayerPoints = (team, playerId) => {
  const key = playerId?.toString?.() || String(playerId || '');
  if (!key) return 0;
  if (team.playerPoints instanceof Map) return Number(team.playerPoints.get(key) || 0);
  return Number(team.playerPoints?.[key] || 0);
};

const setTeamPlayerPoints = (team, playerId, value) => {
  const key = playerId?.toString?.() || String(playerId || '');
  if (!key) return;
  if (!(team.playerPoints instanceof Map)) {
    team.playerPoints = new Map(Object.entries(team.playerPoints || {}));
  }
  team.playerPoints.set(key, Number(value) || 0);
  team.markModified('playerPoints');
};

const normalizePointEvent = (rawEvent) => {
  const type = String(rawEvent?.type || '').trim();
  const detail = String(rawEvent?.detail || '').trim();
  const elapsed = rawEvent?.time?.elapsed;
  const extra = rawEvent?.time?.extra;
  const player = rawEvent?.player || {};
  const assist = rawEvent?.assist || {};
  const team = rawEvent?.team || {};
  const minute = elapsed ? `${elapsed}${extra ? `+${extra}` : ''}'` : "0'";
  const comments = String(rawEvent?.comments || '').trim();
  const outputs = [];

  // 🚫 টাইব্রেকার (Penalty Shootout) এর গোল বা মিস ফ্যান্টাসি পয়েন্টে কাউন্ট হবে না
  if (/shootout/i.test(detail) || /shootout/i.test(comments)) {
    return outputs;
  }

  if (type === 'Goal' && player.id) {
    outputs.push({
      dedupeKey: `goal:${player.id}:${elapsed}:${extra || ''}:${detail}:${assist.id || ''}`,
      playerApiId: player.id,
      playerName: player.name || 'Player',
      teamName: team.name || 'Team',
      minute,
      type: 'goal',
      numPts: LIVE_POINT_RULES.Goal,
      icon: '⚽',
      ptsLabel: `+${LIVE_POINT_RULES.Goal}`
    });
    if (assist.id) {
      outputs.push({
        dedupeKey: `assist:${assist.id}:${player.id}:${elapsed}:${extra || ''}`,
        playerApiId: assist.id,
        playerName: assist.name || 'Player',
        teamName: team.name || 'Team',
        minute,
        type: 'assist',
        numPts: 6,
        icon: '🎯',
        ptsLabel: '+6'
      });
    }
  }

  if (type === 'Card' && player.id) {
    const isRed = /red/i.test(detail);
    const numPts = isRed ? LIVE_POINT_RULES.CardRed : LIVE_POINT_RULES.CardYellow;
    outputs.push({
      dedupeKey: `card:${player.id}:${elapsed}:${extra || ''}:${detail}`,
      playerApiId: player.id,
      playerName: player.name || 'Player',
      teamName: team.name || 'Team',
      minute,
      type: isRed ? 'red' : 'yellow',
      numPts,
      icon: isRed ? '🟥' : '🟨',
      ptsLabel: `${numPts}`
    });
  }

  if (type === 'Var' && /red/i.test(detail) && player.id) {
    outputs.push({
      dedupeKey: `var-red:${player.id}:${elapsed}:${extra || ''}:${detail}`,
      playerApiId: player.id,
      playerName: player.name || 'Player',
      teamName: team.name || 'Team',
      minute,
      type: 'red',
      numPts: LIVE_POINT_RULES.VarRed,
      icon: '🟥',
      ptsLabel: `${LIVE_POINT_RULES.VarRed}`
    });
  }

  if (type === 'Penalty' && /missed/i.test(detail) && player.id) {
    outputs.push({
      dedupeKey: `penalty-missed:${player.id}:${elapsed}:${extra || ''}:${detail}`,
      playerApiId: player.id,
      playerName: player.name || 'Player',
      teamName: team.name || 'Team',
      minute,
      type: 'miss',
      numPts: LIVE_POINT_RULES.PenaltyMissed,
      icon: '❌',
      ptsLabel: `${LIVE_POINT_RULES.PenaltyMissed}`
    });
  }

  return outputs;
};

const applyPointEventToTeams = async (matchId, pointEvent, io) => {
  const player = await Player.findOne({ apiId: pointEvent.playerApiId }).select('_id');
  if (!player) return false;

  const teams = await FantasyTeam.find({ match: matchId, players: player._id });
  if (teams.length === 0) return false;

  for (const team of teams) {
    const currentPoints = getTeamPlayerPoints(team, player._id);
    setTeamPlayerPoints(team, player._id, currentPoints + pointEvent.numPts);

    const starters = team.players.length === 15 ? team.players.slice(0, 11) : team.players;
    const isStarter = starters.some(pId => pId.toString() === player._id.toString());

    if (isStarter) {
      let appliedPoints = pointEvent.numPts;
      if (team.captain?.toString() === player._id.to