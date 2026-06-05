import jwt from 'jsonwebtoken';
import User from '../models/User.js';

export const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  // ১. টোকেন না থাকলে বা ভুল ফরম্যাটে থাকলে শুরুতেই আটকে দেওয়া
  if (!token || token === 'undefined' || token === 'null' || token === '') {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }

  try {
    // ২. JWT এর বেসিক স্ট্রাকচার চেক (Header.Payload.Signature)
    // এটি না থাকলে jwt.verify "jwt malformed" এরর থ্রো করে
    if (token.split('.').length !== 3) {
      return res.status(401).json({ message: 'Not authorized, invalid token format' });
    }

      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'goaladda_secret_key');

      // Get user from the token
      req.user = await User.findById(decoded.id).select('-password');

      if (!req.user) {
        return res.status(401).json({ message: 'Not authorized, user not found' });
      }

      next();
  } catch (error) {
    console.error('Auth Error:', error.message);
    return res.status(401).json({ message: 'Not authorized, token failed' });
  }
};

export const admin = (req, res, next) => {
  if (req.user && req.user.isAdmin) {
    next();
  } else {
    res.status(401).json({ message: 'Not authorized as an admin' });
  }
};
