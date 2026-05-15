import User from '../models/User.js';
import Room from '../models/Room.js';
import FantasyTeam from '../models/FantasyTeam.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import admin from 'firebase-admin';
import mongoose from 'mongoose';

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET || 'goaladda_secret_key', { expiresIn: '30d' });

const SHOP_PAYMENT_METHODS = [
  {
    id: 'bkash',
    label: 'bKash',
    accountNumber: '01711-223344',
    accountName: 'Goal Adda Shop',
  },
  {
    id: 'nagad',
    label: 'Nagad',
    accountNumber: '01888-556677',
    accountName: 'Goal Adda Shop',
  },
];

const SHOP_JERSEYS = [
  { id: 'argentina-home', country: 'Argentina', name: 'Argentina Home Jersey', costCoins: 700, theme: 'argentina' },
  { id: 'brazil-home', country: 'Brazil', name: 'Brazil Home Jersey', costCoins: 700, theme: 'brazil' },
  { id: 'portugal-home', country: 'Portugal', name: 'Portugal Home Jersey', costCoins: 700, theme: 'portugal' },
  { id: 'spain-home', country: 'Spain', name: 'Spain Home Jersey', costCoins: 700, theme: 'spain' },
];

const SHOP_JERSEY_SIZES = ['S', 'M', 'L', 'XL'];

const buildReferralCode = (user) => {
  const namePart = (user.name || 'GOAL')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, 4)
    .padEnd(4, 'X');
  const phonePart = (user.phone || '').replace(/\D/g, '').slice(-4).padStart(4, '0');
  return `${namePart}${phonePart}`;
};

const clampProgress = (current, target) => Math.max(0, Math.min(current, target));

const buildTask = ({ id, title, description, rewardCoins, current, target, cta, forceCompleted }) => {
  const safeCurrent = clampProgress(current, target);
  const isDone = forceCompleted || safeCurrent >= target;
  return {
    id,
    title,
    description,
    rewardCoins,
    current: safeCurrent,
    target,
    completed: isDone,
    progressPercent: target > 0 ? Math.round((safeCurrent / target) * 100) : 100,
    cta,
    isClaimed: forceCompleted || false,
    canClaim: !forceCompleted && safeCurrent >= target,
  };
};

const buildMembershipTier = (user) => {
  if ((user.totalPoints || 0) >= 2500 || (user.wins || 0) >= 25) return 'Elite';
  if ((user.totalPoints || 0) >= 1000 || (user.wins || 0) >= 10) return 'Pro';
  return 'Starter';
};

const buildUserPayload = (user) => ({
  _id: user._id,
  name: user.name,
  phone: user.phone,
  profilePicture: user.profilePicture || '',
  coinBalance: user.coinBalance || 0,
  totalPoints: user.totalPoints || 0,
  weeklyPoints: user.weeklyPoints || 0,
  wins: user.wins || 0,
  globalRank: user.globalRank || 0,
  notifications: user.notifications || [],
});

const buildShopOffers = (user) => {
  const tier = buildMembershipTier(user);

  return {
    currentTier: tier,
    recommendedOfferId: tier === 'Starter' ? 'pro-pack' : 'elite-pack',
    upgradeMessage:
      tier === 'Elite'
        ? 'You are already in the highest membership tier.'
        : `Upgrade from ${tier} to make bigger contest runs.`,
    offers: [
      {
        id: 'starter-pack',
        title: 'Starter Pack',
        subtitle: 'Quick top-up for first exchanges',
        coins: 110,
        priceLabel: 'BDT 100',
        badge: 'Popular',
      },
      {
        id: 'pro-pack',
        title: 'Pro Pack',
        subtitle: 'Balanced boost for regular play',
        coins: 230,
        priceLabel: 'BDT 200',
        badge: tier === 'Starter' ? 'Recommended' : 'Value',
      },
      {
        id: 'elite-pack',
        title: 'Elite Pack',
        subtitle: 'Best value for jersey collectors',
        coins: 480,
        priceLabel: 'BDT 400',
        badge: 'Best Value',
      },
    ],
  };
};

const buildShopPayload = (user) => {
  const tier = buildMembershipTier(user);
  const ownedIds = new Set((user.ownedJerseys || []).map(item => item.jerseyId));

  return {
    currentTier: tier,
    recommendedOfferId: tier === 'Starter' ? 'pro-pack' : 'elite-pack',
    upgradeMessage:
      tier === 'Elite'
        ? 'You are already in the highest membership tier.'
        : `Upgrade from ${tier} to make bigger contest runs.`,
    defaultAddress: user.shippingAddress || '',
    defaultPhone: user.phone || '',
    offers: buildShopOffers(user).offers,
    paymentMethods: SHOP_PAYMENT_METHODS,
    jerseys: SHOP_JERSEYS.map(jersey => ({
      ...jersey,
      owned: ownedIds.has(jersey.id),
      sizeOptions: SHOP_JERSEY_SIZES,
      canExchange: (user.coinBalance || 0) >= jersey.costCoins && !ownedIds.has(jersey.id),
    })),
    ownedJerseys: (user.ownedJerseys || []).map(item => ({
      jerseyId: item.jerseyId,
      name: item.name,
      country: item.country,
      size: item.size,
      shippingAddress: item.shippingAddress,
      phoneNumber: item.phoneNumber,
      costCoins: item.costCoins,
      claimedAt: item.claimedAt,
    })),
    recentRequests: (user.purchaseRequests || [])
      .slice()
      .sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt))
      .slice(0, 5)
      .map(item => ({
        packId: item.packId,
        packTitle: item.packTitle,
        paymentMethod: item.paymentMethod,
        amountLabel: item.amountLabel,
        coins: item.coins,
        paymentReference: item.paymentReference,
        status: item.status,
        submittedAt: item.submittedAt,
      })),
  };
};

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
export const registerUser = async (req, res) => {
  const { name, phone, password, referredBy } = req.body;

  try {
    const safeName = String(name || '').trim();
    const safePhone = String(phone || '').replace(/\D/g, '').slice(0, 11);
    const safePassword = String(password || '');
    const safeReferral = String(referredBy || '').trim().toUpperCase();

    if (!safeName || !safePhone || !safePassword) {
      return res.status(400).json({ message: 'Please add all fields' });
    }

    if (!/^01\d{9}$/.test(safePhone)) {
      return res.status(400).json({ message: 'Enter a valid Bangladesh phone number' });
    }

    if (safePassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    const userExists = await User.findOne({ phone: safePhone });
    if (userExists) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(safePassword, salt);

    let initialCoins = 0;
    let validReferralCode = null;

    // Check and apply referral bonus
    if (safeReferral.length >= 4) {
      const phoneSuffix = safeReferral.slice(-4);
      const potentialReferrers = await User.find({ phone: new RegExp(phoneSuffix + '$') });
      const referrerFound = potentialReferrers.find(u => buildReferralCode(u) === safeReferral);

      if (referrerFound) {
        validReferralCode = safeReferral;
        initialCoins = 20; // New user gets 20 coins as a welcome bonus
      }
    }

    const user = await User.create({
      name: safeName,
      phone: safePhone,
      password: hashedPassword,
      coinBalance: initialCoins,
      referredByCode: validReferralCode
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid user data' });
    }

    res.status(201).json({
      ...buildUserPayload(user),
      token: signToken(user._id),
    });
  } catch (error) {
    console.error('registerUser error:', {
      message: error.message,
      code: error.code,
      name: error.name,
      errors: error.errors ? Object.keys(error.errors) : undefined,
    });

    if (error.code === 11000) {
      return res.status(400).json({ message: 'User already exists' });
    }

    if (error.name === 'ValidationError') {
      const firstError = Object.values(error.errors || {})[0];
      return res.status(400).json({ message: firstError?.message || 'Invalid user data' });
    }

    res.status(500).json({ message: error.message || 'Server error' });
  }
};

// @desc    Authenticate a user
// @route   POST /api/auth/login
// @access  Public
export const loginUser = async (req, res) => {
  const { phone, password } = req.body;

  try {
    const user = await User.findOne({ phone });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    res.status(200).json({
      ...buildUserPayload(user),
      token: signToken(user._id),
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get user profile
// @route   GET /api/auth/profile
// @access  Private
export const getUserProfile = async (req, res) => {
  res.status(200).json(buildUserPayload(req.user));
};

// @desc    Get user profile dashboard
// @route   GET /api/auth/profile/dashboard
// @access  Private
export const getUserProfileDashboard = async (req, res) => {
  try {
    const userDoc = await User.findById(req.user._id).lean();
    if (!userDoc) {
      return res.status(404).json({ message: 'User not found' });
    }

    const [joinedRooms, createdRoomsCount, savedTeamsCount, teamStats] = await Promise.all([
      Room.find({ 'members.user': req.user._id })
        .populate('match', 'homeTeam awayTeam status matchTime league')
        .sort('-createdAt')
        .lean(),
      Room.countDocuments({ createdBy: req.user._id }),
      FantasyTeam.countDocuments({ user: req.user._id }),
      FantasyTeam.aggregate([
        { $match: { user: req.user._id } },
        {
          $group: {
            _id: null,
            bestTeamPoints: { $max: '$totalPoints' },
            totalAwardedPoints: { $sum: '$awardedPoints' },
          },
        },
      ]),
    ]);

    const activeChallenges = joinedRooms.filter(room =>
      ['Upcoming', 'Live'].includes(room.match?.status)
    ).length;
    const completedChallenges = joinedRooms.filter(room => room.match?.status === 'Finished').length;
    const bestTeamPoints = teamStats[0]?.bestTeamPoints || 0;
    const totalAwardedPoints = teamStats[0]?.totalAwardedPoints || 0;
    const membershipTier = buildMembershipTier(userDoc);
    const referralCode = buildReferralCode(userDoc);
    const profileCompletionItems = [
      Boolean(userDoc.name),
      Boolean(userDoc.phone),
      Boolean(userDoc.profilePicture),
      savedTeamsCount > 0,
    ];
    const profileCompletion = Math.round(
      (profileCompletionItems.filter(Boolean).length / profileCompletionItems.length) * 100
    );

    const today = new Date().setHours(0, 0, 0, 0);
    const lastClaim = userDoc.lastDailyClaim ? new Date(userDoc.lastDailyClaim).setHours(0, 0, 0, 0) : null;
    const claimedToday = lastClaim === today;
    const streak = userDoc.dailyStreak || 0;
    const claimedTasks = userDoc.claimedTasks || [];

    const tasks = [];

    if (streak < 5 || (streak === 5 && claimedToday)) {
      tasks.push(buildTask({
        id: 'daily-login',
        title: `Daily Check-in (Day ${Math.min(streak + (claimedToday ? 0 : 1), 5)}/5)`,
        description: 'Login daily to earn free coins.',
        rewardCoins: 2,
        current: claimedToday ? 1 : 0,
        target: 1,
        cta: claimedToday ? 'Claimed' : 'Claim 2 Coins',
        forceCompleted: claimedToday
      }));
    }

    tasks.push(
      buildTask({
        id: 'profile-photo',
        title: 'Add profile photo',
        description: 'Set a profile picture so your profile looks complete.',
        rewardCoins: 5,
        current: userDoc.profilePicture ? 1 : 0,
        target: 1,
        cta: claimedTasks.includes('profile-photo') ? 'Claimed' : (userDoc.profilePicture ? 'Claim Reward' : 'Update photo'),
        forceCompleted: claimedTasks.includes('profile-photo')
      }),
      buildTask({
        id: 'first-team',
        title: 'Build First Team',
        description: 'Create a fantasy squad for an upcoming match.',
        rewardCoins: 10,
        current: savedTeamsCount > 0 ? 1 : 0,
        target: 1,
        cta: claimedTasks.includes('first-team') ? 'Claimed' : (savedTeamsCount > 0 ? 'Claim Reward' : 'Build team'),
        forceCompleted: claimedTasks.includes('first-team')
      }),
      buildTask({
        id: 'join-challenges',
        title: 'Join First Challenge',
        description: 'Compete in a room to grow your rank.',
        rewardCoins: 10,
        current: joinedRooms.length > 0 ? 1 : 0,
        target: 1,
        cta: claimedTasks.includes('join-challenges') ? 'Claimed' : (joinedRooms.length > 0 ? 'Claim Reward' : 'Open challenges'),
        forceCompleted: claimedTasks.includes('join-challenges')
      }),
      buildTask({
        id: 'win-matches',
        title: 'Win 5 Matches',
        description: 'Outscore your opponents in 5 challenge rooms.',
        rewardCoins: 20,
        current: userDoc.wins || 0,
        target: 5,
        cta: claimedTasks.includes('win-matches') ? 'Claimed' : ((userDoc.wins || 0) >= 5 ? 'Claim Reward' : 'View rooms'),
        forceCompleted: claimedTasks.includes('win-matches')
      })
    );

    res.status(200).json({
      profile: {
        ...buildUserPayload(userDoc),
        memberSince: userDoc.createdAt,
      },
      summary: {
        coinBalance: userDoc.coinBalance || 0,
        totalPoints: userDoc.totalPoints || 0,
        weeklyPoints: userDoc.weeklyPoints || 0,
        globalRank: userDoc.globalRank || 0,
        wins: userDoc.wins || 0,
        joinedChallenges: joinedRooms.length,
        createdChallenges: createdRoomsCount,
        activeChallenges,
        completedChallenges,
        savedTeams: savedTeamsCount,
        bestTeamPoints,
        totalAwardedPoints,
        membershipTier,
      },
      recentRooms: joinedRooms.slice(0, 4).map(room => ({
        _id: room._id,
        name: room.name,
        code: room.code,
        memberCount: room.members?.length || 0,
        maxPlayers: room.maxPlayers || 0,
        privacy: room.privacy || 'Public',
        reward: room.reward || 'Bragging Rights',
        isOwner: room.createdBy?.toString() === req.user._id.toString(),
        match: room.match
          ? {
              _id: room.match._id,
              homeTeam: room.match.homeTeam,
              awayTeam: room.match.awayTeam,
              status: room.match.status,
              matchTime: room.match.matchTime,
              league: room.match.league,
            }
          : null,
      })),
      tasks,
      refer: {
        referralCode,
        shareMessage: `Join Goal Adda with my code ${referralCode} and build your football squad.`,
        bonusCoins: 20,
      },
      account: {
        membershipTier,
        profileCompletion,
        phoneVerified: Boolean(userDoc.phone),
        photoAdded: Boolean(userDoc.profilePicture),
        hasBuiltTeam: savedTeamsCount > 0,
        joinedChallenges: joinedRooms.length,
        createdChallenges: createdRoomsCount,
        lastProfileUpdate: userDoc.updatedAt,
      },
      shop: buildShopPayload(userDoc),
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching profile dashboard', error: error.message });
  }
};

// @desc    Claim task reward
// @route   POST /api/auth/tasks/claim
// @access  Private
export const claimTaskReward = async (req, res) => {
  try {
    const { taskId } = req.body;
    const user = await User.findById(req.user._id);

    if (!user) return res.status(404).json({ message: 'User not found' });

    user.claimedTasks = user.claimedTasks || [];
    user.dailyStreak = user.dailyStreak || 0;

    if (taskId === 'daily-login') {
      const today = new Date().setHours(0, 0, 0, 0);
      const lastClaim = user.lastDailyClaim ? new Date(user.lastDailyClaim).setHours(0, 0, 0, 0) : null;

      if (lastClaim === today) {
        return res.status(400).json({ message: 'You already claimed today\'s reward!' });
      }

      if (user.dailyStreak >= 5) {
        return res.status(400).json({ message: 'Daily login reward is only for the first 5 days.' });
      }

      user.coinBalance = (user.coinBalance || 0) + 2;
      user.dailyStreak += 1;
      user.lastDailyClaim = new Date();
      await user.save();

      return res.status(200).json({ 
        message: `Day ${user.dailyStreak} reward claimed! You got 2 coins.`, 
        coinBalance: user.coinBalance,
        dailyStreak: user.dailyStreak
      });
    }

    if (user.claimedTasks.includes(taskId)) {
      return res.status(400).json({ message: 'Reward already claimed!' });
    }

    let rewardCoins = 0;

    if (taskId === 'profile-photo') {
      if (!user.profilePicture) return res.status(400).json({ message: 'Please upload a photo first.' });
      rewardCoins = 5;
    } 
    else if (taskId === 'first-team') {
      const teamExists = await FantasyTeam.exists({ user: user._id });
      if (!teamExists) return res.status(400).json({ message: 'Please build a team first.' });
      rewardCoins = 10;

      // Check if referral bonus should be paid to the referrer
      if (user.referredByCode && !user.referralBonusPaid) {
        const phoneSuffix = user.referredByCode.slice(-4);
        const potentialReferrers = await User.find({ phone: new RegExp(phoneSuffix + '$') });
        const referrerFound = potentialReferrers.find(u => buildReferralCode(u) === user.referredByCode);

        // ম্যাক্সিমাম ১০ জনের রেফারেল বোনাস পাবে (Limit Referral Fraud)
        if (referrerFound && (referrerFound.referralCount || 0) < 10) { 
          referrerFound.coinBalance = (referrerFound.coinBalance || 0) + 20;
          referrerFound.referralCount = (referrerFound.referralCount || 0) + 1;
          
          referrerFound.notifications = referrerFound.notifications || [];
          referrerFound.notifications.push({
            title: "Referral Bonus! 🎉",
            message: `${user.name} built their first team! You earned 20 coins (${referrerFound.referralCount}/10 limits).`,
            isRead: false,
            createdAt: new Date()
          });
          
          await referrerFound.save();
        }
        
        user.referralBonusPaid = true; // Mark as paid so it doesn't happen again
      }
    }
    else if (taskId === 'join-challenges') {
      const roomExists = await Room.exists({ 'members.user': user._id });
      if (!roomExists) return res.status(400).json({ message: 'Please join a challenge first.' });
      rewardCoins = 10;
    }
    else if (taskId === 'win-matches') {
      if ((user.wins || 0) < 5) return res.status(400).json({ message: 'You need 5 wins first.' });
      rewardCoins = 20;
    }
    else {
      return res.status(400).json({ message: 'Invalid task ID' });
    }

    user.coinBalance = (user.coinBalance || 0) + rewardCoins;
    user.claimedTasks.push(taskId);
    await user.save();

    return res.status(200).json({ 
      message: `Task completed! You earned ${rewardCoins} coins.`,
      coinBalance: user.coinBalance,
      claimedTasks: user.claimedTasks
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error claiming task', error: error.message });
  }
};

// @desc    Update user profile picture
// @route   PUT /api/auth/profile-picture
// @access  Private
export const updateProfilePicture = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.profilePicture = req.body.profilePicture || user.profilePicture;
    const updatedUser = await user.save();

    res.json(buildUserPayload(updatedUser));
  } catch (error) {
    res.status(500).json({ message: 'Server error updating profile picture', error: error.message });
  }
};

// @desc    Get shop overview
// @route   GET /api/auth/shop
// @access  Private
export const getShopOverview = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.status(200).json({
      coinBalance: user.coinBalance || 0,
      shop: buildShopPayload(user),
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error fetching shop overview', error: error.message });
  }
};

// @desc    Exchange coins for a jersey
// @route   POST /api/auth/shop/exchange-jersey
// @access  Private
export const exchangeShopJersey = async (req, res) => {
  try {
    const { jerseyId, size, shippingAddress, phoneNumber } = req.body;
    const jersey = SHOP_JERSEYS.find(item => item.id === jerseyId);

    if (!jersey) {
      return res.status(404).json({ message: 'Selected jersey not found' });
    }

    if (!SHOP_JERSEY_SIZES.includes(size)) {
      return res.status(400).json({ message: 'Please select a valid jersey size' });
    }

    if (!shippingAddress || String(shippingAddress).trim().length < 10) {
      return res.status(400).json({ message: 'Please enter a full shipping address' });
    }

    if (!phoneNumber || String(phoneNumber).trim().length < 8) {
      return res.status(400).json({ message: 'Please enter a valid phone number' });
    }

    const updatedUser = await User.findOneAndUpdate(
      { 
        _id: req.user._id,
        'ownedJerseys.jerseyId': { $ne: jerseyId },
        coinBalance: { $gte: jersey.costCoins }
      },
      {
        $inc: { coinBalance: -jersey.costCoins },
        $set: {
          shippingAddress: String(shippingAddress).trim(),
          phone: String(phoneNumber).trim(),
        },
        $push: {
          ownedJerseys: {
            $each: [{
              jerseyId: jersey.id,
              name: jersey.name,
              country: jersey.country,
              size,
              shippingAddress: String(shippingAddress).trim(),
              phoneNumber: String(phoneNumber).trim(),
              costCoins: jersey.costCoins,
              claimedAt: new Date(),
            }],
            $position: 0
          },
        },
      },
      { new: true, lean: true }
    ).select('-password');

    if (!updatedUser) {
      const checkUser = await User.findById(req.user._id).lean();
      if (!checkUser) return res.status(404).json({ message: 'User not found' });
      if ((checkUser.ownedJerseys || []).some(item => item.jerseyId === jerseyId)) {
        return res.status(400).json({ message: 'You already claimed this jersey' });
      }
      return res.status(400).json({ message: 'You need at least 700 coins to exchange this jersey' });
    }

    res.status(200).json({
      message: `${jersey.country} jersey claimed successfully`,
      coinBalance: updatedUser.coinBalance,
      shop: buildShopPayload(updatedUser),
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error exchanging jersey', error: error.message });
  }
};

// @desc    Create a pack purchase request
// @route   POST /api/auth/shop/purchase-request
// @access  Private
export const createShopPurchaseRequest = async (req, res) => {
  try {
    const { packId, paymentMethod, paymentReference } = req.body;
    const method = SHOP_PAYMENT_METHODS.find(item => item.id === paymentMethod);

    if (!method) {
      return res.status(400).json({ message: 'Please select a valid payment method' });
    }

    if (!paymentReference || String(paymentReference).trim().length < 4) {
      return res.status(400).json({ message: 'Please enter a valid payment reference code' });
    }

    const offers = buildShopOffers(req.user).offers;
    const selectedPack = offers.find(item => item.id === packId);

    if (!selectedPack) {
      return res.status(404).json({ message: 'Selected pack not found' });
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.user._id,
      {
        $push: {
          purchaseRequests: {
            $each: [{
              packId: selectedPack.id,
              packTitle: selectedPack.title,
              paymentMethod: method.id,
              paymentReference: String(paymentReference).trim(),
              amountLabel: selectedPack.priceLabel,
              coins: selectedPack.coins,
              status: 'pending',
              submittedAt: new Date(),
            }],
            $position: 0,
            $slice: 30
          },
        },
      },
      { new: true, lean: true }
    ).select('-password');

    if (!updatedUser) return res.status(404).json({ message: 'User not found' });

    res.status(201).json({
      message: 'Purchase request submitted successfully',
      coinBalance: updatedUser.coinBalance || 0,
      shop: buildShopPayload(updatedUser),
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error creating purchase request', error: error.message });
  }
};

// @desc    Delete user profile
// @route   DELETE /api/auth/profile
// @access  Private
export const deleteUserProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Cleanup user data to maintain database integrity
    await FantasyTeam.deleteMany({ user: req.user._id });
    await Room.updateMany(
      { 'members.user': req.user._id },
      { $pull: { members: { user: req.user._id } } }
    );
    await Room.deleteMany({ createdBy: req.user._id });

    await User.findByIdAndDelete(req.user._id);

    res.status(200).json({ message: 'User account deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Server error deleting account', error: error.message });
  }
};

// @desc    Mark all notifications as read
// @route   PUT /api/auth/notifications/read
// @access  Private
export const markNotificationsRead = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.notifications && user.notifications.length > 0) {
      user.notifications.forEach(n => n.isRead = true);
      await user.save();
    }

    res.status(200).json({ message: 'Notifications marked as read' });
  } catch (error) {
    res.status(500).json({ message: 'Server error', error: error.message });
  }
};
