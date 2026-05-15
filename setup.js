import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ১. ফোল্ডারগুলো তৈরি করা
['models', 'controllers', 'routes'].forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath);
        console.log(`✅ Created folder: ${dir}`);
    }
});

// ২. ফাইলগুলোর সঠিক কোড
const userModelCode = `import mongoose from 'mongoose';\n\nconst userSchema = new mongoose.Schema({\n  name: { type: String, default: 'Guest User' },\n  phone: { type: String, required: true, unique: true },\n  totalPoints: { type: Number, default: 0 },\n  globalRank: { type: Number, default: 0 },\n  wins: { type: Number, default: 0 },\n  coinBalance: { type: Number, default: 500 }\n}, { timestamps: true });\n\nconst User = mongoose.model('User', userSchema);\nexport default User;`;

const authControllerCode = `import User from '../models/User.js';\nimport jwt from 'jsonwebtoken';\n\nexport const phoneLogin = async (req, res) => {\n  try {\n    const { phone } = req.body;\n    if (!phone) return res.status(400).json({ message: 'Phone number is required' });\n\n    let user = await User.findOne({ phone });\n    if (!user) {\n      user = await User.create({ phone, name: \`User_\${phone.substring(phone.length - 4)}\` });\n    }\n\n    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'goaladda_secret_key', { expiresIn: '30d' });\n    res.status(200).json({ _id: user._id, name: user.name, phone: user.phone, coinBalance: user.coinBalance, token });\n  } catch (error) {\n    res.status(500).json({ message: 'Server error' });\n  }\n};`;

const authRoutesCode = `import express from 'express';\nimport { phoneLogin } from '../controllers/authController.js';\n\nconst router = express.Router();\nrouter.post('/phone-login', phoneLogin);\n\nexport default router;`;

// ৩. সঠিক ফোল্ডারে ফাইলগুলো সেভ করা
try {
    fs.writeFileSync(path.join(__dirname, 'models', 'User.js'), userModelCode);
    console.log(`✅ Created file: models/User.js`);
    
    fs.writeFileSync(path.join(__dirname, 'controllers', 'authController.js'), authControllerCode);
    console.log(`✅ Created file: controllers/authController.js`);
    
    fs.writeFileSync(path.join(__dirname, 'routes', 'authRoutes.js'), authRoutesCode);
    console.log(`✅ Created file: routes/authRoutes.js`);
    
    console.log("\n🎉 ম্যাজিক সফল! সব ফোল্ডার এবং ফাইল সঠিকভাবে তৈরি হয়েছে।");
    console.log("👉 এখন টার্মিনালে 'npm run dev' কমান্ড দিন।");
} catch (error) {
    console.log("❌ Error:", error.message);
}