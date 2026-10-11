-- AlterTable
ALTER TABLE "StudentProfile" ADD COLUMN     "currentCtc" DECIMAL(12,2),
ADD COLUMN     "currentCtcCurrency" TEXT,
ADD COLUMN     "placementSource" TEXT,
ADD COLUMN     "placementVerifiedAt" TIMESTAMP(3);
