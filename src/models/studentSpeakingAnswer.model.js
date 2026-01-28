var mongoose = require('mongoose'),
    Schema = mongoose.Schema;

const EvaluationCardSchema = new mongoose.Schema(
    {
        cardNumber: { type: Number, required: true },

        fullReport: { type: String },

        totalScore: { type: Number },
        oetGrade: { type: String },

        summary: { type: String },

        strengths: [{ type: String }],
        areasOfImprovement: [{ type: String }],
    },
    { _id: false } // IMPORTANT: avoids extra _id per card
);

const studentSpeakingAnswerSchema = new Schema(
    {

        studentId: { type: Schema.Types.ObjectId },
        courseId: { type: Schema.Types.ObjectId},
        speakingTestId: { type: Schema.Types.ObjectId},
        examType: { type: String, enum: ['oet', 'ielts', 'pte'], default: 'oet' },
        evaluatorId: { type: Schema.Types.ObjectId },
        evaluationType: { type: String, enum: ['ai', 'human'] },
        // Speaking submissions
        studentAttemptId: { type: Schema.Types.ObjectId },
        isPracticeMode: { type: Boolean, default: false }, // coming from testAttempId
        // Writing submission
        mockTestId: { type: Schema.Types.ObjectId},
        speakingAudios: [
            {
                audioUrl: String,
                key: String,
                audioName: String,
                originalName: String,
                speakingPartId: { type: Schema.Types.ObjectId },
                questionId: { type: Schema.Types.ObjectId },
                subQuestionNumber: { type: Number },
            },
        ], // audio URLs

        pdfUrl: {
            pdfUrl: String,
            key: String,
        },

        speakingData: [{ type: String, default: '' }], // possibly transcripts or prompt answers
        testType: { type: String, enum: ['full_mock', 'mini_mock', 'class_test'], default: 'full_mock' },
        // Evaluation flags
        isAiBased: { type: Boolean, default: false },
        // partwiseScores for ielts
        partWiseScores: [
            {
                speakingPartId: { type: Schema.Types.ObjectId },
                questionNumber: { type: Number },
                bands: { type: String },
                score: {
                    type: Number,
                    default: null,
                    validate: {
                        validator: (v) => v === null || (v >= 0 && v <= 500),
                        message: 'score must be null or between 0 and 500',
                    },
                },
            },
        ],
        isApprovedByAccessor: { type: Boolean, default: false },
        approvedBy: { type: Schema.Types.ObjectId, ref: 'employee' },
        approvedAt: { type: Date },
        // Evaluation: fixed-length arrays (e.g., 2 parts)
        cardWiseScores: [
            {
                cardNumber: {
                    type: Number,
                    default: null,
                    validate: {
                        validator: (v) => v === null || v >= 0,
                        message: 'cardNumber must be null or a positive number',
                    },
                },
                score: {
                    type: Number,
                    default: null,
                    validate: {
                        validator: (v) => v === null || (v >= 0 && v <= 500),
                        message: 'score must be null or between 0 and 500',
                    },
                },
            },
        ],
        avgScore: {
            type: Number,
            default: null,
            validate: {
                validator: (v) => v === null || (v >= 0 && v <= 500),
                message: 'avgScore must be null or between 0 and 500',
            },
        },

        cardWiseGrades: [{ cardNumber: Number, score: String }], // e.g., ['B', 'A']
        avgGrade: { type: String }, // e.g., 'A'
        avgBand: { type: String }, // e.g., 'A'
        isEmailSent: { type: Boolean, default: false },
        emailSentAt: { type: Date, default: null },
        checkingStatus: {
            type: String,
            enum: ['pending', 'checked', 'late', 'rejected'],
            default: 'pending',
        },
        evaluationJson: [EvaluationCardSchema],
        // Optional: part-wise feedbacks or remarks
        partWiseFeedback: [
            {
                cardNumber: { type: Number },
                feedback: { type: String },
            },
        ],
        aiFeedback: { type: String, default: null }, // Plain text AI feedback
        aiFeedBackHtml: { type: String, default: null },
        accessorFeedBackHtml: { type: String, default: null },
        accessorFeedBackInPdf: {
            pdfUrl: { type: String, default: null },
            key: { type: String, default: null },
            pdfName: { type: String, default: null },
            originalName: { type: String, default: null },
        },
        transcripts: [{ type: String }],

    },
    { timestamps: true }
);

const StudentSpeakingAnswer = mongoose.model('studentSpeakingAnswer', studentSpeakingAnswerSchema);
module.exports = StudentSpeakingAnswer;
