const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors'); // Đưa dòng này lên nhóm khai báo thư viện
require('dotenv').config();

const app = express(); // 👈 Khởi tạo app phải nằm TRƯỚC
app.use(cors());       // 👈 Khai báo sử dụng cors phải nằm SAU app
app.use(express.json());

// 1. KẾT NỐI CƠ SỞ DỮ LIỆU MONGODB CLOUD (Lấy cấu hình từ file .env)
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ [Database] Đã kết nối thành công tới cơ sở dữ liệu đám mây MongoDB!'))
    .catch(err => console.error('❌ [Database] Lỗi kết nối dữ liệu:', err));

// 2. ĐỊNH NGHĨA CẤU TRÚC LƯU TRỮ TRÊN DATABASE (SCHEMAS)

// Cấu trúc bảng dữ liệu Người dùng (Users)
const userSchema = new mongoose.Schema({
    telegramId: { type: String, required: true, unique: true },
    username: String,
    lionBalance: { type: Number, default: 0 },
    usdtBalance: { type: Number, default: 0 },
    // Thuật toán khai thác 4h
    isMining: { type: Boolean, default: false },
    lastClaimTime: { type: Date, default: null },
    // Hệ thống nhiệm vụ và mời bạn bè
    completedMissions: [String],
    checkinStreak: { type: Number, default: 0 },
    lastCheckinTime: { type: Date, default: null },
    referredUsers: [String], // Danh sách Telegram ID của những người được user này mời
    createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// Cấu trúc bảng dữ liệu Lệnh rút tiền (Withdrawals)
const withdrawalSchema = new mongoose.Schema({
    userId: String,
    type: { type: String, enum: ['CRYPTO', 'BANK'], required: true },
    usdtAmount: Number,
    rate: Number,
    vndAmount: Number,
    bankDetails: {
        bankName: String,
        bankAccount: String,
        accountName: String
    },
    status: { type: String, enum: ['PENDING', 'SUCCESS', 'REJECTED'], default: 'PENDING' },
    createdAt: { type: Date, default: Date.now }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

// 3. CẤU HÌNH CÁC HẰNG SỐ KINH TẾ TRONG GAME
const MINING_RATE_PER_HOUR = 10 / 72; // Tốc độ để 3 ngày (72 giờ) đào đủ 10 LION (~0.138888 LION/giờ)
const MAX_MINING_HOURS = 4; // Chu kỳ đào tối đa là 4 tiếng phải vào bật lại
let CURRENT_USDT_VND_RATE = 25500; // Tỷ giá mặc định dự phòng nếu lỗi API

// TỰ ĐỘNG CẬP NHẬT TỶ GIÁ USDT/VND TỪ THỊ TRƯỜNG THỰC TẾ (Chạy ngầm mỗi 5 phút)
async function fetchLiveExchangeRate() {
    try {
        const response = await axios.get('https://er-api.com');
        if (response.data && response.data.rates.VND) {
            // Giá USDT thị trường tự do thường cao hơn tỷ giá USD ngân hàng khoảng 1.5%
            CURRENT_USDT_VND_RATE = Math.round(response.data.rates.VND * 1.015);
            console.log(`[Tỷ giá] Đã cập nhật giá USDT tự động: ${CURRENT_USDT_VND_RATE.toLocaleString()} VNĐ`);
        }
    } catch (error) {
        console.log('[Tỷ giá] Không lấy được API, sử dụng tỷ giá dự phòng:', CURRENT_USDT_VND_RATE);
    }
}
// Kích hoạt chạy ngay khi bật server và thiết lập lặp lại mỗi 5 phút (300.000 ms)
fetchLiveExchangeRate();
setInterval(fetchLiveExchangeRate, 300000);

// 4. HỆ THỐNG XỬ LÝ API CHỨC NĂNG

// API: ĐĂNG KÝ TÀI KHOẢN MỚI & XỬ LÝ HOA HỒNG MỜI BẠN BÈ (+0.50 LION)
app.post('/api/users/register', async (req, res) => {
    const { telegramId, username, referrerId } = req.body;
    try {
        let user = await User.findOne({ telegramId });
        if (user) return res.json({ isNewUser: false, user });

        // Nếu chưa có, tạo tài khoản mới hoàn toàn
        user = new User({ telegramId, username });
        await user.save();

        // Xử lý cộng thưởng cho người mời (nếu tham gia qua link ref hợp lệ)
        if (referrerId && referrerId !== telegramId) {
            const referrer = await User.findOne({ telegramId: referrerId });
            if (referrer) {
                referrer.lionBalance += 0.50; // Cộng 0.50 LION theo barem mới
                referrer.referredUsers.push(telegramId); // Ghi nhận danh sách đã mời
                await referrer.save();
                console.log(`[Referral] Người dùng ${referrerId} nhận +0.50 LION từ việc mời ${telegramId}`);
            }
        }
        res.json({ isNewUser: true, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: LẤY TRẠNG THÁI MÁY ĐÀO REALTIME TRÊN GIAO DIỆN APP
app.get('/api/mining/status/:telegramId', async (req, res) => {
    try {
        const user = await User.findOne({ telegramId: req.params.telegramId });
        if (!user) return res.status(404).json({ message: "Không tìm thấy tài khoản người dùng" });

        if (!user.isMining || !user.lastClaimTime) {
            return res.json({ isMining: false, pendingLion: 0, timeLeft: 0 });
        }

        const now = new Date();
        const hoursElapsed = (now - new Date(user.lastClaimTime)) / (1000 * 60 * 60);
        let pendingLion = 0;
        let timeLeft = 0;
        let isMiningFinished = false;

        if (hoursElapsed >= MAX_MINING_HOURS) {
            // Đã quá 4 tiếng, máy dừng, nhận tối đa sản lượng chu kỳ 4 tiếng
            pendingLion = MAX_MINING_HOURS * MINING_RATE_PER_HOUR; // ~0.5555 LION
            timeLeft = 0;
            isMiningFinished = true;
        } else {
            // Máy đang chạy, tính toán số xu đào được tăng lên theo thời gian thực
            pendingLion = hoursElapsed * MINING_RATE_PER_HOUR;
            timeLeft = (MAX_MINING_HOURS - hoursElapsed) * 3600; // Đổi số giờ còn lại ra Giây để làm đồng hồ đếm ngược
        }

        res.json({
            isMining: user.isMining,
            isMiningFinished,
            pendingLion: pendingLion.toFixed(6),
            timeLeft: Math.floor(timeLeft),
            currentBalance: user.lionBalance
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: BẤM NHẬN LION & BẬT LẠI CHU KỲ ĐÀO 4 TIẾNG TIẾP THEO
app.post('/api/mining/claim', async (req, res) => {
    const { telegramId } = req.body;
    try {
        const user = await User.findOne({ telegramId });
        const now = new Date();

        // Nếu máy đang tắt hoàn toàn, kích hoạt chu kỳ mới luôn
        if (!user.isMining) {
            user.isMining = true;
            user.lastClaimTime = now;
            await user.save();
            return res.json({ message: "Kích hoạt máy đào 4 giờ thành công!", user });
        }

        const hoursElapsed = (now - new Date(user.lastClaimTime)) / (1000 * 60 * 60);
        if (hoursElapsed < MAX_MINING_HOURS) {
            return res.status(400).json({ message: "Chưa hết chu kỳ 4 giờ, vui lòng đợi máy khai thác xong!" });
        }

        // Đủ điều kiện: Cộng tiền vào ví tổng và tự động gia hạn chu kỳ 4h tiếp theo
        const reward = MAX_MINING_HOURS * MINING_RATE_PER_HOUR;
        user.lionBalance += reward;
        user.lastClaimTime = now; 
        await user.save();

        res.json({ 
            message: `Nhận thành công ${reward.toFixed(4)} LION và đã tự động bật lại máy đào chu kỳ mới!`, 
            lionBalance: user.lionBalance 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: XỬ LÝ SWAP TOKEN TRONG VÍ (TỶ LỆ 10 LION = 0.1 USDT)
app.post('/api/wallet/swap', async (req, res) => {
    const { telegramId, lionAmount } = req.body;
    if (lionAmount < 10 || lionAmount % 10 !== 0) {
        return res.status(400).json({ message: "Số lượng LION quy đổi phải từ 10 xu và là bội số của 10" });
    }
    try {
        const user = await User.findOne({ telegramId });
        if (user.lionBalance < lionAmount) return res.status(400).json({ message: "Số dư LION trong ví không đủ" });

        // Quy đổi: 10 LION = 0.1 USDT -> 1 LION = 0.01 USDT
        const usdtReceived = lionAmount * 0.01;
        user.lionBalance -= lionAmount;
        user.usdtBalance += usdtReceived;
        await user.save();

        res.json({ message: "Đổi LION sang USDT thành công!", lionBalance: user.lionBalance, usdtBalance: user.usdtBalance });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: LỆNH RÚT USDT VỀ NGÂN HÀNG VIỆT NAM (MIN 0.1 USDT - TỰ ĐỘNG TÍNH THEO GIÁ LIVE)
app.post('/api/wallet/withdraw-bank', async (req, res) => {
    const { telegramId, usdtAmount, bankName, bankAccount, accountName } = req.body;
    if (usdtAmount < 0.1) return res.status(400).json({ message: "Hạn mức rút tiền tối thiểu là 0.1 USDT" });

    try {
        const user = await User.findOne({ telegramId });
        if (user.usdtBalance < usdtAmount) return res.status(400).json({ message: "Số dư USDT trong tài khoản không đủ để thực hiện" });

        // Tự động tính số tiền VNĐ người dùng thực nhận theo tỷ giá thời gian thực lúc bấm rút
        const vndAmountToPay = Math.round(usdtAmount * CURRENT_USDT_VND_RATE);

        // Trừ số dư USDT của người dùng ngay lập tức trên app để tránh lỗi rút lặp (Double Spending)
        user.usdtBalance -= usdtAmount;
        await user.save();

        // Lưu thông tin giao dịch vào bảng dữ liệu Chờ duyệt (Admin duyệt thủ công để an toàn)
        const tx = new Withdrawal({
            userId: telegramId,
            type: 'BANK',
            usdtAmount,
            rate: CURRENT_USDT_VND_RATE,
            vndAmount: vndAmountToPay,
            bankDetails: { bankName, bankAccount, accountName }
        });
        await tx.save();

        res.json({ 
            message: "Lệnh rút tiền đã gửi lên hệ thống thành công!",
            vndRealReceive: vndAmountToPay.toLocaleString() + " VNĐ",
            remainingUsdt: user.usdtBalance
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ====== HỆ THỐNG API DÀNH CHO ADMIN PANEL ======

// API ĐỂ ADMIN LẤY DANH SÁCH TẤT CẢ LỆNH RÚT TIỀN VÀ TRẠNG THÁI THỐNG KÊ
app.get('/api/admin/withdrawals', async (req, res) => {
    try {
        // Lấy tất cả lệnh rút tiền, sắp xếp lệnh mới nhất lên đầu tiên
        const list = await Withdrawal.find().sort({ createdAt: -1 });
        // Đếm xem có bao nhiêu lệnh đang ở trạng thái PENDING (Chờ duyệt)
        const pendingCount = await Withdrawal.countDocuments({ status: 'PENDING' });

        res.json({
            currentRate: CURRENT_USDT_VND_RATE,
            pendingCount,
            list
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API ĐỂ ADMIN PHÊ DUYỆT LỆNH RÚT TIỀN (CHUYỂN TRẠNG THÁI SANG SUCCESS)
app.post('/api/admin/withdraw/approve/:id', async (req, res) => {
    try {
        const tx = await Withdrawal.findById(req.params.id);
        if (!tx) return res.status(404).json({ message: "Không tìm thấy lệnh giao dịch này!" });
        if (tx.status === 'SUCCESS') return res.status(400).json({ message: "Lệnh này đã được duyệt từ trước rồi!" });

        // Chuyển trạng thái sang Thành công
        tx.status = 'SUCCESS';
        await tx.save();

        res.json({ message: "Phê duyệt lệnh thành công! Trạng thái đã chuyển sang SUCCESS." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// KHỞI CHẠY MÁY CHỦ
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 [Server] Hệ thống Lion Coin đang chạy ngầm trên điện thoại tại cổng: ${PORT}`));
