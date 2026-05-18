export const checkStreamHealth = async (req, res) => {
  try {
    // You can later add logic to check if your IPTV scraper is active
    res.status(200).json({ ok: true, message: 'Stream service is ready' });
  } catch (error) {
    res.status(500).json({ ok: false, message: 'Stream service error' });
  }
};

export const getMatchStreams = async (req, res) => {
  const { matchId } = req.params;
  
  try {
    // Placeholder streams. You can integrate your IPTV scraper logic here later.
    res.status(200).json({
      available: true,
      message: 'Streams fetched successfully',
      streams: [
        {
          url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
          quality: 'Auto',
          language: 'English'
        }
      ]
    });
  } catch (error) {
    res.status(500).json({ available: false, message: 'Error fetching streams' });
  }
};

export const refreshMatchStreams = async (req, res) => {
  const { matchId } = req.params;
  
  try {
    // For now, call the same GET function. In the future, this can force a scraper re-run.
    return getMatchStreams(req, res);
  } catch (error) {
    res.status(500).json({ available: false, message: 'Error refreshing streams' });
  }
};