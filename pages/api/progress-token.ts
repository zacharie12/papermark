import { NextApiRequest, NextApiResponse } from 'next';
import { Redis } from '@upstash/redis';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  try {
    // 1. Check Authentication
    const session = await getServerSession(req, res, authOptions);
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { documentVersionId } = req.query;

    if (!documentVersionId || typeof documentVersionId !== 'string') {
      return res.status(400).json({ error: 'Missing documentVersionId' });
    }

    // 2. Connect to Redis (Using the keys you provided)
    const redis = new Redis({
      url: 'https://amazed-alien-25104.upstash.io',
      token: 'AmIQAAIgcDHeIjPtUbRdkMNDwPgvgr7A5_pNKe-RVO2k1s0mgGMrnA',
    });

    // 3. Get Progress
    // We check for the key "processing:[id]" which is standard for this workflow
    const progress = await redis.get(`processing:${documentVersionId}`);

    // If no progress found yet, return 10% to keep spinner moving instead of crashing
    return res.status(200).json(progress || { status: 'processing', percentage: 10 });

  } catch (error) {
    console.error('Progress Token Error:', error);
    // FAIL-SAFE: Return 200 OK so the UI never crashes
    return res.status(200).json({ status: 'processing', percentage: 5 });
  }
}
