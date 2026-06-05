import User from '../models/User.js';
import mongoose from 'mongoose';

// @desc    Get all pending purchase requests for admin
// @route   GET /api/admin/payments/requests/pending
// @access  Private/Admin
export const getPendingPurchaseRequests = async (req, res) => {
  try {
    const usersWithPendingRequests = await User.aggregate([
      // Find users who have at least one pending purchase request
      { $match: { 'purchaseRequests.status': 'pending' } },
      // Unwind the purchaseRequests array to treat each request as a separate document
      { $unwind: '$purchaseRequests' },
      // Filter only the pending requests
      { $match: { 'purchaseRequests.status': 'pending' } },
      // Project the necessary fields
      {
        $project: {
          _id: 0, // Exclude the default _id field
          userId: '$_id',
          userName: '$name',
          userPhone: '$phone',
          requestId: '$purchaseRequests._id',
          packId: '$purchaseRequests.packId',
          packTitle: '$purchaseRequests.packTitle',
          paymentMethod: '$purchaseRequests.paymentMethod',
          paymentReference: '$purchaseRequests.paymentReference',
          amountLabel: '$purchaseRequests.amountLabel',
          coins: '$purchaseRequests.coins',
          status: '$purchaseRequests.status',
          submittedAt: '$purchaseRequests.submittedAt',
        },
      },
      // Sort by submission date
      { $sort: { submittedAt: 1 } },
    ]);

    res.status(200).json(usersWithPendingRequests);
  } catch (error) {
    console.error('Error fetching pending purchase requests:', error);
    res.status(500).json({ message: 'Server error fetching pending requests', error: error.message });
  }
};

// @desc    Update status of a purchase request (approve/reject)
// @route   PUT /api/admin/payments/requests/:userId/:requestId
// @access  Private/Admin
export const updatePurchaseRequestStatus = async (req, res) => {
  const { userId, requestId } = req.params;
  const { status } = req.body; // 'approved' or 'rejected'

  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ message: 'Invalid status provided. Must be "approved" or "rejected".' });
  }

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const request = user.purchaseRequests.id(requestId);
    if (!request) return res.status(404).json({ message: 'Purchase request not found' });

    if (request.status !== 'pending') {
      return res.status(400).json({ message: `Request is already ${request.status}. Cannot update.` });
    }

    request.status = status;

    if (status === 'approved') {
      user.coinBalance = (user.coinBalance || 0) + request.coins;
    }

    await user.save();

    res.status(200).json({ message: `Purchase request ${status} successfully.`, request });
  } catch (error) {
    console.error('Error updating purchase request status:', error);
    res.status(500).json({ message: 'Server error updating request status', error: error.message });
  }
};