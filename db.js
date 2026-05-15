import mongoose from 'mongoose';

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
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
