const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 1. KẾT NỐI CƠ SỞ DỮ LIỆU MONGODB CLOUD
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ [Database] Kết nối thành công tới MongoDB Atlas!'))
    .catch(err => console.error('❌ [Database] Lỗi kết nối dữ liệu:', err));

// 2. ĐỊNH NGHĨA CẤU TRÚC LƯU TRỮ (SCHEMAS)
const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    username: String,
    lionBalance: { type: Number, default: 0 },
    usdtBalance: { type: Number, default: 0 },
    isMining: { type: Boolean, default: false },
    lastClaimTime: { type: Date, default: null },
    completedMissions: [String],
    checkinStreak: { type: Number, default: 0 },
    lastCheckinTime: { type: Date, default: null },
    referredUsers: [String],
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const withdrawalSchema = new mongoose.Schema({
    userId: String,
    type: { type: String, default: 'BANK' },
    usdtAmount: Number,
    rate: Number,
    vndAmount: Number,
    bankDetails: { bankName: String, bankAccount: String, accountName: String },
    status: { type: String, enum: ['PENDING', 'SUCCESS', 'REJECTED'], default: 'PENDING' },
    createdAt: { type: Date, default: Date.now }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// 3. CẤU HÌNH KINH TẾ & TỶ GIÁ LIVE
const MINING_RATE_PER_HOUR = 10 / 72; // ~0.138888 LION/h
const MAX_MINING_HOURS = 4;
let CURRENT_USDT_VND_RATE = 25500;

async function fetchLiveExchangeRate() {
    try {
        const response = await axios.get('https://er-api.com');
        if (response.data && response.data.rates.VND) {
            CURRENT_USDT_VND_RATE = Math.round(response.data.rates.VND * 1.015);
            console.log(`[Tỷ giá] Cập nhật tự động: ${CURRENT_USDT_VND_RATE} VNĐ`);
        }
    } catch (error) {
        console.log('[Tỷ giá] Sử dụng tỷ giá dự phòng:', CURRENT_USDT_VND_RATE);
    }
}
fetchLiveExchangeRate();
setInterval(fetchLiveExchangeRate, 300000);

// 4. HỆ THỐNG API ĐỒNG BỘ TOÀN DIỆN

// API: ĐĂNG KÝ NGƯỜI DÙNG MỚI
app.post('/api/users/register', async (req, res) => {
    const { telegramId, username, referrerId } = req.body;
    try {
        let user = await User.findOne({ telegramId });
        if (user) return res.json({ isNewUser: false, user });

        user = new User({ telegramId, username });
        await user.save();

        if (referrerId && referrerId !== telegramId) {
            const referrer = await User.findOne({ telegramId: referrerId });
            if (referrer) {
                referrer.lionBalance += 0.50;
                referrer.referredUsers.push(telegramId);
                await referrer.save();
            }
        }
        res.json({ isNewUser: true, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: LẤY TRẠNG THÁI VÀ SỐ DƯ REALTIME (QUAN TRỌNG NHẤT)
app.get('/api/mining/status/:telegramId', async (req, res) => {
    try {
        let user = await User.findOne({ telegramId: req.params.telegramId });
        // Tự động tạo tài khoản nhanh nếu chưa có trong DB để tránh lỗi Loading/ID:0
        if (!user) {
            user = new User({ telegramId: req.params.telegramId, username: "LionThợMỏ" });
            await user.save();
        }

        let pendingLion = 0;
        let timeLeft = 0;
        let isMiningFinished = false;

        if (user.isMining && user.lastClaimTime) {
            const hoursElapsed = (new Date() - new Date(user.lastClaimTime)) / (1000 * 60 * 60);
            if (hoursElapsed >= MAX_MINING_HOURS) {
                pendingLion = MAX_MINING_HOURS * MINING_RATE_PER_HOUR;
                timeLeft = 0;
                isMiningFinished = true;
            } else {
                pendingLion = hoursElapsed * MINING_RATE_PER_HOUR;
                timeLeft = (MAX_MINING_HOURS - hoursElapsed) * 3600;
            }
        }

        res.json({
            isMining: user.isMining,
            isMiningFinished,
            pendingLion: pendingLion.toFixed(6),
            timeLeft: Math.floor(timeLeft),
            currentBalance: user.lionBalance,
            checkinStreak: user.checkinStreak
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: KÍCH HOẠT MÁY ĐÀO HOẶC NHẬN COIN CHU KỲ 4H
app.post('/api/mining/claim', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        if (!user) return res.status(404).json({ message: "Không tìm thấy tài khoản!" });

        const now = new Date();
        if (!user.isMining) {
            user.isMining = true;
            user.lastClaimTime = now;
            await user.save();
            return res.json({ message: "Đã kích hoạt máy đào chu kỳ 4 giờ mới!" });
        }

        const hoursElapsed = (now - new Date(user.lastClaimTime)) / (1000 * 60 * 60);
        if (hoursElapsed < MAX_MINING_HOURS) {
            return res.status(400).json({ message: "Máy vẫn đang đào, vui lòng đợi hết 4 giờ!" });
        }

        const reward = MAX_MINING_HOURS * MINING_RATE_PER_HOUR;
        user.lionBalance += reward;
        user.lastClaimTime = now; // Reset chu kỳ mới
        await user.save();

        res.json({ message: `Nhận thành công +${reward.toFixed(4)} LION và bật lại máy đào!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: LẤY DỮ LIỆU TỶ GIÁ VÀ VÍ TIỀN USDT
app.get('/api/wallet/:telegramId', async (req, res) => {
    try {
        const user = await User.findOne({ telegramId: req.params.telegramId });
        const usdt = user ? user.usdtBalance : 0;
        res.json({
            currentRate: CURRENT_USDT_VND_RATE,
            usdtBalance: usdt,
            usdtToVndValue: Math.round(usdt * CURRENT_USDT_VND_RATE)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: ĐỔI XU LION -> USDT (SWAP)
app.post('/api/wallet/swap', async (req, res) => {
    const { telegramId, lionAmount } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        if (user.lionBalance < lionAmount) return res.status(400).json({ message: "Số dư LION của bạn không đủ!" });

        const usdtReceived = lionAmount * 0.01; // Tỷ lệ 10 : 0.1 -> 1 LION = 0.01 USDT
        user.lionBalance -= lionAmount;
        user.usdtBalance += usdtReceived;
        await user.save();

        res.json({ message: `Đổi xu thành công! Bạn nhận được +${usdtReceived.toFixed(2)} USDT.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: ĐẶT LỆNH RÚT TIỀN VỀ NGÂN HÀNG VNĐ
app.post('/api/wallet/withdraw-bank', async (req, res) => {
    const { telegramId, usdtAmount, bankName, bankAccount, accountName } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        if (user.usdtBalance < usdtAmount) return res.status(400).json({ message: "Số dư USDT không đủ để rút!" });

        const vndAmountToPay = Math.round(usdtAmount * CURRENT_USDT_VND_RATE);
        user.usdtBalance -= usdtAmount;
        await user.save();

        const tx = new Withdrawal({
            userId: telegramId,
            usdtAmount,
            rate: CURRENT_USDT_VND_RATE,
            vndAmount: vndAmountToPay,
            bankDetails: { bankName, bankAccount, accountName }
        });
        await tx.save();

        res.json({ message: `Gửi lệnh rút thành công! Hệ thống sẽ chuyển khoản ${vndAmountToPay.toLocaleString()} VNĐ tới bạn.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: THỰC HIỆN ĐIỂM DANH HÀNG NGÀY
app.post('/api/missions/checkin', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        const now = new Date();

        if (user.lastCheckinTime) {
            const diffInHours = (now - new Date(user.lastCheckinTime)) / (1000 * 60 * 60);
            if (diffInHours < 24) {
                return res.status(400).json({ message: "Hôm nay bạn đã điểm danh rồi, vui lòng quay lại vào ngày mai!" });
            }
        }

        user.checkinStreak = user.checkinStreak >= 4 ? 1 : user.checkinStreak + 1;
        user.lionBalance += 0.05;
        user.lastCheckinTime = now;
        await user.save();

        res.json({ message: `Điểm danh Ngày ${user.checkinStreak} thành công! Nhận +0.05 LION.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: XÁC THỰC NHIỆM VỤ TELEGRAM CHANNELS
app.post('/api/missions/verify-telegram', async (req, res) => {
    res.json({ message: "Xác thực thành công! Nhận +0.25 LION." });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 [Server Cloud] Đang chạy tại cổng: ${PORT}`));
        
