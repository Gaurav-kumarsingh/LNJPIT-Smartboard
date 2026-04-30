import re

with open('server.js', 'r', encoding='utf-8') as f:
    code = f.read()

# 1. Remove Mongoose and User model
code = code.replace("const mongoose  = require('mongoose');\n", '')
code = re.sub(r'// ── MongoDB User model.*?const User = require\(\'./models/User\'\);\n', '', code, flags=re.DOTALL)
# also remove mongoose connection logs
code = re.sub(r'// Mongoose global settings\n.*?\n// Connection event logging.*?\n.*?\n.*?\n.*?\n', '', code, flags=re.DOTALL)

# 2. Update env validation
code = code.replace("'MONGODB_URI', 'JWT_SECRET'", "'JWT_SECRET'")

# 3. Remove connection helper
code = re.sub(r'// ══════════════════════════════════════════════════════════════════════════════\n// MONGODB ATLAS — connection helper with retry logic.*?async function connectWithRetry.*?}\n}\n', '', code, flags=re.DOTALL)

# 4. Update login
old_login = '''    // ── Lookup in MongoDB (also selects +password field) ─────────────────────
    const user = await User.findByLogin(username.trim());
    if (!user)
      return res.status(401).json({ error: 'Invalid username or password' });

    // ── Compare password ──────────────────────────────────────────────────────
    const match = await user.comparePassword(password);
    if (!match)
      return res.status(401).json({ error: 'Invalid username or password' });

    // ── Issue JWT ────────────────────────────────────────────────────────────────────
    const expiresIn = '7d';
    const token = jwt.sign(
      { id: user._id.toHexString(), username: user.username, iat: Math.floor(Date.now() / 1000) },
      SECRET_KEY,
      { expiresIn }
    );'''

new_login = '''    // ── Lookup in .env ───────────────────────────────────────────────────────
    if (
      username.trim() !== process.env.DEFAULT_USER_USERNAME ||
      password !== process.env.DEFAULT_USER_PASSWORD
    ) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // ── Issue JWT ────────────────────────────────────────────────────────────────────
    const expiresIn = '7d';
    const token = jwt.sign(
      { id: 'env_user_1', username: process.env.DEFAULT_USER_USERNAME, iat: Math.floor(Date.now() / 1000) },
      SECRET_KEY,
      { expiresIn }
    );
    const user = { _id: { toHexString: () => 'env_user_1' }, username: process.env.DEFAULT_USER_USERNAME };'''
code = code.replace(old_login, new_login)

# 5. Admin GET users
old_get_users = '''    // Exclude password hash; return id, username, created_at
    const users = await User.find({}, 'username created_at').lean();
    // Normalise _id → id for frontend compatibility
    res.json(users.map(u => ({ id: u._id.toHexString(), username: u.username, created_at: u.created_at })));'''

new_get_users = '''    const users = [];
    if (process.env.DEFAULT_USER_USERNAME) {
      users.push({ id: 'env_user_1', username: process.env.DEFAULT_USER_USERNAME, created_at: new Date() });
    }
    res.json(users);'''
code = code.replace(old_get_users, new_get_users)

# 6. Admin POST users
old_post_users = '''    // The pre-save hook in User.js automatically bcrypt-hashes the password before saving
    const newUser = new User({ username: username.trim(), password });
    await newUser.save();

    console.log(`[Admin] ✅ Created user: ${newUser.username}`);
    res.json({ id: newUser._id.toHexString(), username: newUser.username });'''

new_post_users = '''    return res.status(400).json({ error: 'MongoDB has been removed. Please add users via the .env file.' });'''
code = code.replace(old_post_users, new_post_users)

# 7. Admin DELETE users
old_delete_users = '''    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: 'Invalid user ID' });

    const deleted = await User.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: 'User not found' });

    console.log(`[Admin] 🗑 Deleted user: ${deleted.username}`);
    res.json({ success: true });'''

new_delete_users = '''    return res.status(400).json({ error: 'MongoDB has been removed. Please manage users via the .env file.' });'''
code = code.replace(old_delete_users, new_delete_users)

# 8. startServer logic
code = re.sub(r'    console\.log\(\'⏳  Connecting to MongoDB Atlas…\'\);\n    await connectWithRetry\(5\);\n    \n    // Seed default user if provided in \.env.*?}\n    }\n', '', code, flags=re.DOTALL)
code = code.replace("console.error('❌  Cannot start server: MongoDB unreachable after retries.');\n    console.error('    Check MONGODB_URI, Atlas Network Access, and cluster status.');", "console.error('❌  Cannot start server:', err.message);")

# 9. Health check
code = re.sub(r'const dbState = mongoose\.connection\.readyState;.*?const isOk     = dbState === 1;', 'const isOk = true;', code, flags=re.DOTALL)
code = code.replace("db:        stateMap[dbState] || 'unknown',", "db: 'removed',")

with open('server.js', 'w', encoding='utf-8') as f:
    f.write(code)
print("done")
