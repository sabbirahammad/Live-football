import mongoose from 'mongoose';
import dotenv from 'dotenv';
import ShopItem from './models/ShopItem.js';
import connectDB from './db.js';

dotenv.config();

const seedItems = [
  {
    title: 'Messi Magic',
    imageUrl: 'https://i.pinimg.com/736x/88/ed/99/88ed99cf5903b41865a77fde315f69f8.jpg',
    costCoins: 50,
    type: 'profile_bg'
  },
  {
    title: 'Ronaldo CR7',
    imageUrl: 'https://i.pinimg.com/736x/21/df/b6/21dfb6fc8e652ed9680ed901b87a8101.jpg',
    costCoins: 50,
    type: 'profile_bg'
  },
  {
    title: 'Neymar Jr',
    imageUrl: 'https://i.pinimg.com/736x/ee/f5/db/eef5db21d05260dd3c6da1d279ec3ed9.jpg',
    costCoins: 50,
    type: 'profile_bg'
  },
  {
    title: 'Mbappe',
    imageUrl: 'https://i.pinimg.com/736x/32/7a/a8/327aa8c5dfb56b5ce53e5b3064223fbe.jpg',
    costCoins: 50,
    type: 'profile_bg'
  }
];

const seedDB = async () => {
  try {
    await connectDB();
    await ShopItem.deleteMany();
    await ShopItem.insertMany(seedItems);
    console.log('Shop items seeded successfully');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding shop items:', error);
    process.exit(1);
  }
};

seedDB();
