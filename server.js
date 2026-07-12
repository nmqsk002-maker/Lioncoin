const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ĐỊNH NGHĨA HẰNG SỐ CỦA CHỦ DỰ ÁN (ADMIN THẬT)
const ADMIN_TELEGRAM_ID = "8374664614";
const CHAT_GROUP_USERNAME = "@baoappfreekonap";

// 1. KẾT NỐI DATABASE ĐÁM MÂY MONGODB ATLAS
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ [Database Live] Kết nối bảo mật thành công!'))
    .catch(err => console.error('❌ [Database] Lỗi kết nối:', err));

// 2. CẤU TRÚC BẢNG DỮ LIỆU THỢ MỎ (SCHEMAS)
const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    username: String,
    lionBalance: { type: Number, default: 0 },
    usdtBalance: { type: Number, default: 0 },
    diamondBalance: { type: Number, default: 100 },
    minerLevel: { type: Number, default: 1 },
    boostMultiplier: { type: Number, default: 1 },
    boostExpiresAt: { type: Date, default: null },
    isMining: { type: Boolean, default: false },
    lastClaimTime: { type: Date, default: null },
    completedMissions: [String],
    adsWatchedToday: { type: Number, default: 0 },
    lastAdWatchTime: { type: Date, default: null },
    checkinStreak: { type: Number, default: 0 },
    lastCheckinTime: { type: Date, default: null },
    referredUsers: [String],
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const withdrawalSchema = new mongoose.Schema({
    userId: String,
    username: String,
    usdtAmount: Number,
    rate: Number,
    vndAmount: Number,
    bankDetails: { bankName: String, bankAccount: String, accountName: String },
    status: { type: String, enum: ['PENDING', 'SUCCESS', 'REJECTED'], default: 'PENDING' },
    createdAt: { type: Date, default: Date.now }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// 3. THÔNG SỐ ĐỊNH GIÁ KINH TẾ GAMEFI CHẠY THẬT
const MINER_CONFIGS = {
    1: { name: "Basic Miner", speed: 10 / 72, cost: 0 },
    2: { name: "Silver Miner", speed: 0.35, cost: 1000 },
    3: { name: "Gold Miner", speed: 1.20, cost: 5000 },
    4: { name: "Diamond Miner", speed: 3.50, cost: 20000 },
    5: { name: "Lion Miner", speed: 10.00, cost: 100000 }
};

const BOOST_CONFIGS = {
    "x2_speed": { multiplier: 2, durationMinutes: 30, costDiamonds: 20 },
    "x3_speed": { multiplier: 3, durationMinutes: 15, costDiamonds: 30 },
    "x5_speed": { multiplier: 5, durationMinutes: 30, costDiamonds: 50 }
};

const MAX_MINING_HOURS = 4;
let CURRENT_USDT_VND_RATE = 25500;

async function fetchLiveRate() {
    try {
        const response = await axios.get('https://er-api.com');
        if (response.data?.rates?.VND) CURRENT_USDT_VND_RATE = Math.round(response.data.rates.VND * 1.015);
    } catch (e) { console.log('Lỗi API tỷ giá, dùng giá dự phòng.'); }
}
fetchLiveRate(); setInterval(fetchLiveRate, 300000);

// Middleware bảo mật: Chỉ cho phép duy nhất UID của bạn truy cập các cổng dữ liệu nhạy cảm
function verifyAdmin(req, res, next) {
    const adminId = req.headers['admin-id'];
    if (adminId !== ADMIN_TELEGRAM_ID) {
        return res.status(403).json({ message: "Quyền truy cập bị từ chối! Bạn không phải Admin hệ thống." });
    }
    next();
}

// 4. HỆ THỐNG CÁC API VẬN HÀNH THỰC TẾ

app.get('/api/mining/status/:telegramId', async (req, res) => {
    try {
        let user = await User.findOne({ telegramId: req.params.telegramId });
        if (!user) { user = new User({ telegramId: req.params.telegramId, username: "Lion_Miner" }); await user.save(); }

        let activeMultiplier = 1;
        if (user.boostExpiresAt && new Date(user.boostExpiresAt) > new Date()) activeMultiplier = user.boostMultiplier;

        const totalMiningSpeed = MINER_CONFIGS[user.minerLevel].speed * activeMultiplier;
        let pendingLion = 0, timeLeft = 0, isMiningFinished = false;

        if (user.isMining && user.lastClaimTime) {
            const hoursElapsed = (new Date() - new Date(user.lastClaimTime)) / (1000 * 60 * 60);
            if (hoursElapsed >= MAX_MINING_HOURS) { pendingLion = MAX_MINING_HOURS * totalMiningSpeed; isMiningFinished = true; }
            else { pendingLion = hoursElapsed * totalMiningSpeed; timeLeft = (MAX_MINING_HOURS - hoursElapsed) * 3600; }
        }

        res.json({
            isMining: user.isMining, isMiningFinished, pendingLion: pendingLion.toFixed(6),
            timeLeft: Math.floor(timeLeft), currentBalance: user.lionBalance, diamondBalance: user.diamondBalance,
            minerLevel: user.minerLevel, miningSpeedPerHour: totalMiningSpeed.toFixed(4), boostMultiplier: activeMultiplier,
            adsWatchedToday: user.adsWatchedToday, checkinStreak: user.checkinStreak, isAdmin: req.params.telegramId === ADMIN_TELEGRAM_ID,
            boostTimeLeftSeconds: user.boostExpiresAt && new Date(user.boostExpiresAt) > new Date() ? Math.floor((new Date(user.boostExpiresAt) - new Date()) / 1000) : 0
        });
    } catch (err) { res.status(500).json({ error: "Lỗi đồng bộ hệ thống!" }); }
});

app.post('/api/mining/claim', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        const now = new Date();
        if (!user.isMining) { user.isMining = true; user.lastClaimTime = now; await user.save(); return res.json({ message: "Kích hoạt máy đào thành công!" }); }

        const hoursElapsed = (now - new Date(user.lastClaimTime)) / (1000 * 60 * 60);
        if (hoursElapsed < MAX_MINING_HOURS) return res.status(400).json({ message: "Chưa hết chu kỳ 4 giờ!" });

        let activeMultiplier = 1;
        if (user.boostExpiresAt && new Date(user.boostExpiresAt) > new Date()) activeMultiplier = user.boostMultiplier;

        const reward = MAX_MINING_HOURS * MINER_CONFIGS[user.minerLevel].speed * activeMultiplier;
        user.lionBalance = parseFloat((user.lionBalance + reward).toFixed(6));
        user.lastClaimTime = now; await user.save();
        res.json({ message: `Nhận thành công +${reward.toFixed(4)} LION!` });
    } catch (err) { res.status(500).json({ error: "Lỗi claim!" }); }
});

app.post('/api/missions/watch-ad', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        const now = new Date();
        if (user.lastAdWatchTime && (now - new Date(user.lastAdWatchTime)) < 30000) {
            return res.status(400).json({ message: "Bạn đang xem quảng cáo quá nhanh! Vui lòng đợi 30s." });
        }
        if (user.adsWatchedToday >= 5) {
            const isNextDay = user.lastAdWatchTime && new Date(user.lastAdWatchTime).getDate() !== now.getDate();
            if (!isNextDay) return res.status(400).json({ message: "Bạn đã đạt giới hạn xem 5 quảng cáo/ngày hôm nay!" });
            user.adsWatchedToday = 0;
        }
        user.lionBalance = parseFloat((user.lionBalance + 0.02).toFixed(6));
        user.adsWatchedToday += 1;
        user.lastAdWatchTime = now;
        await user.save();
        res.json({ message: `Xem quảng cáo thành công! +0.02 LION (Hôm nay: ${user.adsWatchedToday}/5).` });
    } catch (err) { res.status(500).json({ error: "Lỗi xem Ads!" }); }
});

app.post('/api/shop/upgrade', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        const nextLevel = user.minerLevel + 1;
        if (!MINER_CONFIGS[nextLevel]) return res.status(400).json({ message: "Máy đào đã đạt cấp tối đa!" });

        const cost = MINER_CONFIGS[nextLevel].cost;
        if (user.lionBalance < cost) return res.status(400).json({ message: `Số dư không đủ! Cần thêm LION.` });

        user.lionBalance -= cost; user.minerLevel = nextLevel; await user.save();
        res.json({ message: `Nâng cấp thành công lên ${MINER_CONFIGS[nextLevel].name}!` });
    } catch (err) { res.status(500).json({ error: "Lỗi nâng cấp!" }); }
});

app.post('/api/boost/buy', async (req, res) => {
    const { telegramId, boostId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        const config = BOOST_CONFIGS[boostId];
        if (user.diamondBalance < config.costDiamonds) return res.status(400).json({ message: "Kim cương không đủ!" });

        const expiresAt = new Date(); expiresAt.setMinutes(expiresAt.getMinutes() + config.durationMinutes);
        user.diamondBalance -= config.costDiamonds; user.boostMultiplier = config.multiplier; user.boostExpiresAt = expiresAt;
        await user.save();
        res.json({ message: `Kích hoạt thành công gói Boost x${config.multiplier}!` });
    } catch (err) { res.status(500).json({ error: "Lỗi mua Boost!" }); }
// API 6: SWAP LION -> USDT (10 LION = 0.1 USDT)
app.post('/api/wallet/swap', async (req, res) => {
    const { telegramId, lionAmount } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        if (user.lionBalance < lionAmount) return res.status(400).json({ message: "Số dư ví không đủ!" });
        user.lionBalance = parseFloat((user.lionBalance - lionAmount).toFixed(6));
        user.usdtBalance = parseFloat((user.usdtBalance + (lionAmount * 0.01)).toFixed(4)); await user.save();
        res.json({ message: "Đổi xu sang tài sản USDT thành công!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// API 7: RÚT TIỀN VỀ NGÂN HÀNG TRỰC TIẾP
app.post('/api/wallet/withdraw-bank', async (req, res) => {
    const { telegramId, usdtAmount, bankName, bankAccount, accountName } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        if (user.usdtBalance < usdtAmount) return res.status(400).json({ message: "Số dư USDT không đủ!" });
        const vnd = Math.round(usdtAmount * CURRENT_USDT_VND_RATE);
        user.usdtBalance = parseFloat((user.usdtBalance - usdtAmount).toFixed(4)); await user.save();
        const tx = new Withdrawal({ userId: telegramId, username: user.username, usdtAmount, rate: CURRENT_USDT_VND_RATE, vndAmount: vnd, bankDetails: { bankName, bankAccount, accountName } });
        await tx.save();
        res.json({ message: `Gửi lệnh thành công! Chờ Admin chuyển khoản ${vnd.toLocaleString()} VNĐ.` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// API 8: ĐIỂM DANH CHUỖI NGÀY KHÓA 24H
app.post('/api/missions/checkin', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        const now = new Date();
        if (user.lastCheckinTime && ((now - new Date(user.lastCheckinTime)) / (1000 * 60 * 60)) < 24) {
            return res.status(400).json({ message: "Hôm nay bạn đã điểm danh rồi!" });
        }
        user.checkinStreak = user.checkinStreak >= 4 ? 1 : user.checkinStreak + 1;
        user.lionBalance = parseFloat((user.lionBalance + 0.05).toFixed(6)); user.lastCheckinTime = now; await user.save();
        res.json({ message: `Điểm danh ngày ${user.checkinStreak} thành công! +0.05 LION.` });
    } catch (err) { res.status(500).json({ error: "Lỗi điểm danh!" }); }
});

// API 9: XÁC THỰC NHIỆM VỤ TELEGRAM CHANNELS QUA BOT THẬT CHAT_GROUP_USERNAME
app.post('/api/missions/verify-telegram', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        if (user.completedMissions.includes('TELEGRAM_JOIN')) return res.status(400).json({ message: "Bạn đã nhận thưởng rồi!" });

        const tgUrl = `https://telegram.org{process.env.BOT_TOKEN}/getChatMember?chat_id=${CHAT_GROUP_USERNAME}&user_id=${telegramId}`;
        const tgRes = await axios.get(tgUrl);
        if (['member', 'administrator', 'creator'].includes(tgRes.data?.result?.status)) {
            user.lionBalance = parseFloat((user.lionBalance + 0.25).toFixed(6)); user.completedMissions.push('TELEGRAM_JOIN'); await user.save();
            return res.json({ message: "Xác thực thành công! Nhận +0.25 LION." });
        }
        res.status(400).json({ message: "Bạn chưa tham gia vào kênh Telegram nhóm của dự án!" });
    } catch (e) { res.status(400).json({ message: "Hãy ấn /start chat với Bot trước khi làm nhiệm vụ kiểm tra!" }); }
});

app.get('/api/wallet/:telegramId', async (req, res) => {
    try {
        const user = await User.findOne({ telegramId: req.params.telegramId });
        const usdt = user ? user.usdtBalance : 0;
        res.json({ currentRate: CURRENT_USDT_VND_RATE, usdtBalance: usdt, usdtToVndValue: Math.round(usdt * CURRENT_USDT_VND_RATE) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===================================================
// 👑 CÁC CỔNG API CHUYÊN DỤNG CHO ADMIN DUYỆT TAY THẬT
// ===================================================

// API ADMIN: LẤY TOÀN BỘ DANH SÁCH THÀNH VIÊN ĐÃ ĐĂNG KÝ
app.get('/api/admin/users', verifyAdmin, async (req, res) => {
    try {
        const users = await User.find().sort({ createdAt: -1 });
        res.json(users);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// API ADMIN: LẤY TOÀN BỘ ĐƠN RÚT TIỀN ĐANG CHỜ PHÊ DUYỆT
app.get('/api/admin/withdrawals', verifyAdmin, async (req, res) => {
    try {
        const list = await Withdrawal.find().sort({ createdAt: -1 });
        res.json({ currentRate: CURRENT_USDT_VND_RATE, list });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// API ADMIN: PHÊ DUYỆT HOẶC TỪ CHỐI ĐƠN RÚT CỦA THÀNH VIÊN
app.post('/api/admin/withdraw/action', verifyAdmin, async (req, res) => {
    const { orderId, status } = req.body; // status: 'SUCCESS' hoặc 'REJECTED'
    try {
        const tx = await Withdrawal.findById(orderId);
        if (!tx) return res.status(404).json({ message: "Không tìm thấy lệnh giao dịch!" });
        if (tx.status !== 'PENDING') return res.status(400).json({ message: "Lệnh rút này đã được xử lý từ trước!" });

        tx.status = status;
        await tx.save();

        // Nếu từ chối (REJECTED) -> Hoàn lại tiền USDT vào tài khoản cho User
        if (status === 'REJECTED') {
            const user = await User.findOne({ telegramId: tx.userId });
            if (user) {
                user.usdtBalance = parseFloat((user.usdtBalance + tx.usdtAmount).toFixed(4));
                await user.save();
            }
        }
        res.json({ message: `Đã cập nhật trạng thái đơn sang ${status} thành công!` });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
// ===================================================
// 🤖 TÍCH HỢP KHỞI CHẠY BOT TELEGRAM SONG SONG (MỚI)
// ===================================================
const { Telegraf, Markup } = require('telegraf');
if (process.env.BOT_TOKEN) {
    const bot = new Telegraf(process.env.BOT_TOKEN);

    bot.start(async (ctx) => {
        const telegramUser = ctx.from;
        const referrerId = ctx.payload;

        console.log(`[Bot Live] Khách hàng nhấn Start: ${telegramUser.first_name} (UID: ${telegramUser.id})`);

        try {
            // Khắc phục lỗi 404: Gọi trực tiếp vào mô hình Database ngầm thay vì gọi qua link URL bên ngoài
            let user = await User.findOne({ telegramId: telegramUser.id.toString() });
            let isNewUser = false;

            if (!user) {
                user = new User({ 
                    telegramId: telegramUser.id.toString(), 
                    username: telegramUser.username || telegramUser.first_name 
                });
                await user.save();
                isNewUser = true;

                // Cộng thưởng LION cho người mời
                if (referrerId && referrerId !== telegramUser.id.toString()) {
                    const referrer = await User.findOne({ telegramId: referrerId });
                    if (referrer) {
                        referrer.lionBalance = parseFloat((referrer.lionBalance + 0.50).toFixed(6));
                        referrer.referredUsers.push(telegramUser.id.toString());
                        await referrer.save();
                    }
                }
            }

            let welcomeMessage = `🦁 <b>CHÀO MỪNG ĐẾN VỚI VƯƠNG QUỐC LION COIN!</b> 🦁\n\n`;
            welcomeMessage += `⚡ Hãy nhấn ngay vào nút <b>Play App 🦁</b> ở góc dưới bên trái màn hình chat để mở giao diện kích hoạt máy đào chu kỳ 4h/lần.\n\n`;
            welcomeMessage += `💰 Tích lũy đủ 10 LION để thực hiện đổi (Swap) sang USDT và rút trực tiếp về tài khoản Ngân hàng Việt Nam an toàn tức thì!`;
            
            if (isNewUser && referrerId) {
                welcomeMessage += `\n\n🎁 Hệ thống đã ghi nhận bạn tham gia qua mã giới thiệu của bạn bè!`;
            }

            await ctx.replyWithHTML(welcomeMessage, 
                Markup.inlineKeyboard([
                    [Markup.button.webApp('Play App 🦁', process.env.MINI_APP_URL || 'https://vercel.app')] 
                ])
            );
        } catch (error) {
            console.error("Lỗi Bot Start xử lý dữ liệu:", error.message);
            ctx.reply("Chào mừng bạn đến với Lion Coin! Vui lòng nhấn nút Menu dưới góc trái để mở ứng dụng ngay.");
        }
    });

    bot.launch().then(() => console.log('✅ [Bot Live] Khởi chạy thành công song song cùng Server!'));
} else {
    console.log('⚠️ Không tìm thấy BOT_TOKEN trong cấu hình, Bot chưa bật.');
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 [Máy chủ Thương mại] Đang vận hành trực tuyến tại cổng: ${PORT}`));
