import { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({
    hasSlackId: !!process.env.SLACK_CLIENT_ID,
    hasSlackSecret: !!process.env.SLACK_CLIENT_SECRET, // This will be FALSE
    redisUrl: process.env.UPSTASH_REDIS_REST_URL, // See if this is undefined
    redisToken: !!process.env.UPSTASH_REDIS_REST_TOKEN ? "Present" : "Missing",
  });
}
