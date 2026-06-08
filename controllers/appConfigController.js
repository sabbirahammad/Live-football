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
    const { latestVersion, updateUrl, forceUpdate, updateMessage, globalStreamLinks, fallbackAutoLink } = req.body;
    let config = await AppConfig.findOne();
    if (config) {
      if (latestVersion !== undefined) config.latestVersion = latestVersion;
      if (updateUrl !== undefined) config.updateUrl = updateUrl;
      if (forceUpdate !== undefined) config.forceUpdate = forceUpdate;
      if (updateMessage !== undefined) config.updateMessage = updateMessage;
      if (globalStreamLinks !== undefined) config.globalStreamLinks = globalStreamLinks;
      if (fallbackAutoLink !== undefined) config.fallbackAutoLink = fallbackAutoLink;
      await config.save();
    } else {
      config = await AppConfig.create({ latestVersion, updateUrl, forceUpdate, updateMessage, globalStreamLinks, fallbackAutoLink });
    }
    res.status(200).json(config);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};