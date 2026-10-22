// Public settings for the browser. The anon key is designed to be public;
// your data is protected by the Row Level Security rules in supabase.sql.
module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ url: process.env.SUPABASE_URL || '', anon: process.env.SUPABASE_ANON_KEY || '' });
};
