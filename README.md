# Quick Deploy to Vercel (EASIEST WAY)

## Steps:

1. **Upload to GitHub:**
   - Create a new GitHub repository
   - Push this web-proxy folder to it

2. **Deploy to Vercel (2 minutes):**
   - Go to https://vercel.com
   - Sign up with GitHub (free)
   - Click "New Project"
   - Import your GitHub repo
   - Click "Deploy"

3. **Connect Your Domain (www.1a2b.dev):**
   - In Vercel dashboard, go to Settings → Domains
   - Add "www.1a2b.dev"
   - Vercel will show you 2 DNS records to add
   - Go to your domain provider and add those records
   - Wait 5-10 minutes

Done! Your proxy will be live at www.1a2b.dev

## Alternative: Use Vercel's Free Domain
If you don't want to set up DNS, Vercel gives you a free domain like:
`yourproject.vercel.app`

This works immediately after deploy!