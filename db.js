import mongoose from 'mongoose';

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000, // Fail fast (5s) instead of hanging for 30s
      socketTimeoutMS: 45000,
      family: 4 // Force IPv4 if IPv6 is causing issues with Atlas
    });

    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

    const usersCollection = conn.connection.collection('users');
    const indexes = await usersCollection.indexes();
    const hasLegacyEmailIndex = indexes.some((index) => index.name === 'email_1');

    if (hasLegacyEmailIndex) {
      await usersCollection.dropIndex('email_1');
      console.log('🧹 Dropped legacy users.email_1 index');
    }
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    // Exit process with failure
    process.exit(1);
  }
};

export default connectDB;
