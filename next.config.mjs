const nextConfig = {
  reactStrictMode: true,
  // Vercel sets VERCEL_GIT_COMMIT_SHA per deploy but doesn't expose it to
  // the client automatically - baking it in here lets the running app
  // compare itself against whatever's currently live (see /api/version)
  // to show an "update available" prompt. Blank in local dev, which is
  // the point - nothing to compare against there.
  env: {
    NEXT_PUBLIC_BUILD_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? "",
  },
};

export default nextConfig;
