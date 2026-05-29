import ManualStream from '../models/ManualStream.js';

// অ্যাডমিন প্যানেল থেকে নির্দিষ্ট ম্যাচের লিংকগুলো পাওয়া
export const getManualStreams = async (req, res) => {
  try {
    const { matchId } = req.params;
    const streams = await ManualStream.find({ matchId }).sort({ isBest: -1, createdAt: -1 });
    res.status(200).json({ success: true, streams });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// নতুন লিংক অ্যাড করা
export const addManualStream = async (req, res) => {
  try {
    const { matchId, streamUrl, quality, language, isBest } = req.body;
    
    // যদি এটা Best Stream হয়, তবে আগের সব Best Stream ফলস করে দেওয়া
    if (isBest) {
      await ManualStream.updateMany({ matchId }, { $set: { isBest: false } });
    }

    const newStream = await ManualStream.create({
      matchId, streamUrl, quality, language, isBest
    });

    res.status(201).json({ success: true, stream: newStream });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// লিংক ডিলিট করা
export const deleteManualStream = async (req, res) => {
  try {
    const { streamId } = req.params;
    await ManualStream.findByIdAndDelete(streamId);
    res.status(200).json({ success: true, message: 'Stream deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// লিংক Active/Inactive করা (যাতে ডিলিট না করেই লিংক অফ করা যায়)
export const toggleStreamStatus = async (req, res) => {
  try {
    const { streamId } = req.params;
    const stream = await ManualStream.findById(streamId);
    if (!stream) return res.status(404).json({ message: 'Stream not found' });
    
    stream.isActive = !stream.isActive;
    await stream.save();
    
    res.status(200).json({ success: true, stream });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};