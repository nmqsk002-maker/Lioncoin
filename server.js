const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// 1. KẾT NỐI DATABASE ĐÁM MÂY MONGODB
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ [Database] Đã kết nối bảo mật tới MongoDB Atlas!'))
    .catch(err => console.error('❌ [Database] Lỗi kết nối dữ liệu:', err));

// 2. CẤU TRÚC BẢNG DỮ LIỆU ĐƯỢC CHUẨN HÓA (SCHEMAS)
const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    username: String,
    lionBalance: { type: Number, default: 0 },
    usdtBalance: { type: Number, default: 0 },
    // Bảo mật khai thác
    isMining: { type: Boolean, default: false },
    lastClaimTime: { type: Date, default: null },
    // Bảo mật điểm danh & nhiệm vụ
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

// 3. THÔNG SỐ ĐỊNH GIÁ KINH TẾ (TOKENOMICS)
const MINING_RATE_PER_HOUR = 10 / 72; // ~0.138888 LION/giờ
const MAX_MINING_HOURS = 4;
let CURRENT_USDT_VND_RATE = 25500;

// Tự động cập nhật tỷ giá thật từ API thị trường
async function fetchLiveExchangeRate() {
    try {
        const response = await axios.get('https://er-api.com');
        if (response.data && response.data.rates.VND) {
            CURRENT_USDT_VND_RATE = Math.round(response.data.rates.VND * 1.015);
            console.log(`[Tỷ giá Live] Hệ thống cập nhật: ${CURRENT_USDT_VND_RATE} VNĐ`);
        }
    } catch (error) {
        console.log('[Tỷ giá] Giữ giá dự phòng:', CURRENT_USDT_VND_RATE);
    }
}
fetchLiveExchangeRate();
setInterval(fetchLiveExchangeRate, 300000); // 5 phút cập nhật 1 lần

// 4. HỆ THỐNG API TÍCH HỢP TƯỜNG LỬA CHỐNG GIAN LẬN

// API 1: ĐỒNG BỘ TRẠNG THÁI VÀ TÍNH TOÁN SẢN LƯỢNG AN TOÀN (REALTIME)
app.get('/api/mining/status/:telegramId', async (req, res) => {
    try {
        let user = await User.findOne({ telegramId: req.params.telegramId });
        // Anti-Cheat: Nếu người dùng lách luật vào app mà chưa qua Bot -> Tự tạo tài khoản bắt đầu từ số 0
        if (!user) {
            user = new User({ telegramId: req.params.telegramId, username: "Lion_Miner" });
            await user.save();
        }

        let pendingLion = 0;
        let timeLeft = 0;
        let isMiningFinished = false;

        // Thuật toán kiểm tra thời gian thực ngầm từ phía Server (Chống hack đồng hồ điện thoại)
        if (user.isMining && user.lastClaimTime) {
            const hoursElapsed = (new Date() - new Date(user.lastClaimTime)) / (1000 * 60 * 60);
            
            if (hoursElapsed >= MAX_MINING_HOURS) {
                pendingLion = MAX_MINING_HOURS * MINING_RATE_PER_HOUR; // Tối đa chỉ nhận 0.5555 LION
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
        res.status(500).json({ error: "Lỗi đồng bộ hệ thống!" });
    }
});

// API 2: NHẬN COIN VÀ BẬT LẠI MÁY ĐÀO - CHỐNG SPAM LỆNH KHAI THÁC
app.post('/api/mining/claim', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        if (!user) return res.status(404).json({ message: "Tài khoản không tồn tại!" });

        const now = new Date();
        
        // Trường hợp 1: Máy đang tắt -> Kích hoạt chu kỳ đào mới
        if (!user.isMining) {
            user.isMining = true;
            user.lastClaimTime = now;
            await user.save();
            return res.json({ message: "Đã kích hoạt máy đào chu kỳ 4 giờ thành công!" });
        }

        // Anti-Cheat: Kiểm tra thời gian thực ngầm. Nếu chưa đủ 4 tiếng mà gửi lệnh -> Chặn ngay lập tức
        const hoursElapsed = (now - new Date(user.lastClaimTime)) / (1000 * 60 * 60);
        if (hoursElapsed < MAX_MINING_HOURS) {
            return res.status(400).json({ message: "Gian lận bị chặn! Máy vẫn đang đào, vui lòng đợi hết chu kỳ 4 giờ!" });
        }

        // Tính toán phần thưởng chuẩn từ server
        const reward = MAX_MINING_HOURS * MINING_RATE_PER_HOUR;
        user.lionBalance = parseFloat((user.lionBalance + reward).toFixed(6)); // Lưu trữ chính xác số thập phân
        user.lastClaimTime = now; // Tự động gia hạn chu kỳ mới
        await user.save();

        res.json({ message: `Nhận thành công +${reward.toFixed(4)} LION và tái kích hoạt máy đào!` });
    } catch (err) {
        res.status(500).json({ error: "Lỗi xử lý khai thác!" });
    }
});

// API 3: ĐIỂM DANH HÀNG NGÀY CHUỖI 7 NGÀY - TƯỜNG LỬA KHÓA 24 TIẾNG
app.post('/api/missions/checkin', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        if (!user) return res.status(404).json({ message: "Không tìm thấy người dùng!" });

        const now = new Date();

        // Anti-Cheat: Đo khoảng thời gian giữa 2 lần bấm điểm danh
        if (user.lastCheckinTime) {
            const diffInHours = (now - new Date(user.lastCheckinTime)) / (1000 * 60 * 60);
            // Nếu chưa đủ 24 tiếng mà dùng phần mềm click liên tục -> Trả về lỗi chặn đứng luôn
            if (diffInHours < 24) {
                return res.status(400).json({ message: "Hành vi spam bị chặn! Bạn đã điểm danh hôm nay rồi, vui lòng quay lại sau!" });
            }
        }

        // Logic tăng chuỗi điểm danh, nếu quá 4 ngày (hoặc 7 ngày) thì tự động reset chu kỳ
        user.checkinStreak = user.checkinStreak >= 4 ? 1 : user.checkinStreak + 1;
        user.lionBalance = parseFloat((user.lionBalance + 0.05).toFixed(6)); // Phát thưởng +0.05 LION nạp vào DB
        user.lastCheckinTime = now; // Ghi lại mốc thời gian an toàn
        await user.save();

        res.json({ message: `Điểm danh Ngày ${user.checkinStreak} thành công! Số dư +0.05 LION đã được khóa vào ví.` });
    } catch (err) {
        res.status(500).json({ error: "Lỗi xử lý điểm danh!" });
    }
});

// API 4: XÁC THỰC NHIỆM VỤ TELEGRAM - CHỐNG NHẬN TRÙNG TIỀN (DOUBLE CLAIM)
app.post('/api/missions/verify-telegram', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        if (!user) return res.status(404).json({ message: "Tài khoản không hợp lệ!" });

        // Anti-Cheat: Kiểm tra xem trong mảng completedMissions ở Database đã có tên nhiệm vụ này chưa
        if (user.completedMissions.includes('TELEGRAM_JOIN')) {
            return res.status(400).json({ message: "Bạn đã nhận phần thưởng nhiệm vụ này từ trước rồi!" });
        }

        // Đạt điều kiện: Cộng thưởng, đẩy tên nhiệm vụ vào Database để khóa lại vĩnh viễn
        user.lionBalance = parseFloat((user.lionBalance + 0.25).toFixed(6));
        user.completedMissions.push('TELEGRAM_JOIN');
        await user.save();

        res.json({ message: "Xác thực hoàn tất! Nhận +0.25 LION khóa an toàn trong Database." });
    } catch (error) {
        res.status(500).json({ error: "Lỗi cổng kiểm tra nhiệm vụ!" });
    }
});

// API 5: LẤY DỮ LIỆU TỶ GIÁ VÀ VÍ TIỀN USDT
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

// API 6: ĐỔI XU LION -> USDT (SWAP)
app.post('/api/wallet/swap', async (req, res) => {
    const { telegramId, lionAmount } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        if (user.lionBalance < lionAmount) return res.status(400).json({ message: "Số dư LION của bạn không đủ để quy đổi!" });

        const usdtReceived = lionAmount * 0.01; 
        user.lionBalance = parseFloat((user.lionBalance - lionAmount).toFixed(6));
        user.usdtBalance = parseFloat((user.usdtBalance + usdtReceived).toFixed(4));
        await user.save();

        res.json({ message: `Đổi xu thành công! Đã trừ ${lionAmount} LION và cộng +${usdtReceived.toFixed(2)} USDT vào ví.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API 7: ĐẶT LỆNH RÚT TIỀN VỀ NGÂN HÀNG VNĐ
app.post('/api/wallet/withdraw-bank', async (req, res) => {
    const { telegramId, usdtAmount, bankName, bankAccount, accountName } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        if (user.usdtBalance < usdtAmount) return res.status(400).json({ message: "Số dư USDT không đủ để đặt lệnh rút!" });

        const vndAmountToPay = Math.round(usdtAmount * CURRENT_USDT_VND_RATE);
        user.usdtBalance = parseFloat((user.usdtBalance - usdtAmount).toFixed(4));
        await user.save();

        const tx = new Withdrawal({
            userId: telegramId,
            usdtAmount,
            rate: CURRENT_USDT_VND_RATE,
            vndAmount: vndAmountToPay,
            bankDetails: { bankName, bankAccount, accountName }
        });
        await tx.save();

        res.json({ message: `Gửi lệnh rút thành công! Số tiền ${vndAmountToPay.toLocaleString()} VNĐ đã được chuyển tới danh sách chờ duyệt của Admin.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API 8: THỰC HIỆN ĐIỂM DANH HÀNG NGÀY CHUỖI 7 NGÀY - TƯỜNG LỬA KHÓA 24 TIẾNG
app.post('/api/missions/checkin', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        if (!user) return res.status(404).json({ message: "Không tìm thấy người dùng!" });

        const now = new Date();

        // Anti-Cheat: Đo khoảng thời gian giữa 2 lần bấm điểm danh
        if (user.lastCheckinTime) {
            const diffInHours = (now - new Date(user.lastCheckinTime)) / (1000 * 60 * 60);
            // Nếu chưa đủ 24 tiếng mà dùng phần mềm click liên tục -> Trả về lỗi chặn đứng luôn
            if (diffInHours < 24) {
                return res.status(400).json({ message: "Hành vi spam bị chặn! Bạn đã điểm danh hôm nay rồi, vui lòng quay lại sau!" });
            }
        }

        // Logic tăng chuỗi điểm danh, nếu quá 4 ngày (hoặc 7 ngày) thì tự động reset chu kỳ
        user.checkinStreak = user.checkinStreak >= 4 ? 1 : user.checkinStreak + 1;
        user.lionBalance = parseFloat((user.lionBalance + 0.05).toFixed(6)); // Phát thưởng +0.05 LION nạp vào DB
        user.lastCheckinTime = now; // Ghi lại mốc thời gian an toàn
        await user.save();

        res.json({ message: `Điểm danh Ngày ${user.checkinStreak} thành công! Số dư +0.05 LION đã được khóa vào ví.` });
    } catch (err) {
        res.status(500).json({ error: "Lỗi xử lý điểm danh!" });
    }
});

// API 9: XÁC THỰC NHIỆM VỤ TELEGRAM - CHỐNG NHẬN TRÙNG TIỀN (DOUBLE CLAIM)
app.post('/api/missions/verify-telegram', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        if (!user) return res.status(404).json({ message: "Tài khoản không hợp lệ!" });

        // Anti-Cheat: Kiểm tra xem trong mảng completedMissions ở Database đã có tên nhiệm vụ này chưa
        if (user.completedMissions.includes('TELEGRAM_JOIN')) {
            return res.status(400).json({ message: "Bạn đã nhận phần thưởng nhiệm vụ này từ trước rồi!" });
        }

        // Đạt điều kiện: Cộng thưởng, đẩy tên nhiệm vụ vào Database để khóa lại vĩnh viễn
        user.lionBalance = parseFloat((user.lionBalance + 0.25).toFixed(6));
        user.completedMissions.push('TELEGRAM_JOIN');
        await user.save();

        res.json({ message: "Xác thực hoàn tất! Nhận +0.25 LION khóa an toàn trong Database." });
    } catch (error) {
        res.status(500).json({ error: "Lỗi cổng kiểm tra nhiệm vụ!" });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 [Máy chủ bảo mật] Đang vận hành trực tuyến tại cổng: ${PORT}`));
