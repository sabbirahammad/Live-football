import AppConfig from '../models/AppConfig.js';

// @desc    Get latest app version info
// @route   GET /api/app-config/update
export const getUpdateInfo = async (req, res) => {
  try {
    let config = await AppConfig.findOne().sort({ createdAt: -1 });
    if (!config) {
      config = await AppConfig.create({
        latestVersion: '1.0.0',
        updateUrl: 'https://elitepassit.com/',
        forceUpdate: false,
        updateMessage: 'অ্যাপের নতুন আপডেট এসেছে। ভালো পারফরম্যান্স পেতে এখনই আপডেট করে নিন!'
      });
    }
    res.status(200).json(config);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update app version (Admin Only)
// @route   PUT /api/app-config/update
export const updateAppConfig = async (req, res) => {
  try {
    const { latestVersion, updateUrl, forceUpdate, updateMessage } = req.body;
    let config = await AppConfig.findOne();
    if (config) {
      config.latestVersion = latestVersion || config.latestVersion;
      config.updateUrl = updateUrl || config.updateUrl;
      config.forceUpdate = forceUpdate !== undefined ? forceUpdate : config.forceUpdate;
      config.updateMessage = updateMessage || config.updateMessage;
      await config.save();
    } else {
      config = await AppConfig.create({ latestVersion, updateUrl, forceUpdate, updateMessage });
    }
    res.status(200).json(config);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};