// lib/sponsorship.ts
import * as fs from "fs"
import * as path from "path"
import type { ContributorStats } from "../lib/types"

interface SponsorshipConfig {
  baseRate?: number // Base amount for contributors with score > 3 but no stars
  issueConversionRate?: number // Points per issue created
  issueCap?: number // Maximum issues considered per contributor
}

const DEFAULT_CONFIG: SponsorshipConfig = {
  baseRate: 5, // $5 base sponsorship for contributors with score > 3
  issueConversionRate: 0.2, // $0.2 per issue created
  issueCap: 100, // Max 100 issues considered
}

export class SponsorshipCalculator {
  private config: SponsorshipConfig

  constructor(config: SponsorshipConfig = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      baseRate: Number(config.baseRate ?? DEFAULT_CONFIG.baseRate),
      issueConversionRate: Number(
        config.issueConversionRate ?? DEFAULT_CONFIG.issueConversionRate,
      ),
      issueCap: Number(config.issueCap ?? DEFAULT_CONFIG.issueCap),
    }
  }

  /**
   * Generates monthly CSV with sponsorship amounts and contribution breakdown
   */
  public generateMonthlyCSV(): void {
    const currentDate = new Date()
    const monthName = currentDate.toLocaleString("default", { month: "long" })
    const year = currentDate.getFullYear()

    // Aggregate data for the entire month
    const monthlyData = this.aggregateMonthlyData(currentDate)
    const { csvContent, fileName } = this.formatCSV(
      monthlyData,
      monthName,
      year,
    )

    // Ensure sponsorships directory exists
    const csvDir = path.join(__dirname, "../sponsorships")
    this.ensureDirectoryExists(csvDir)

    // Write CSV file
    const csvPath = path.join(csvDir, fileName)
    fs.writeFileSync(csvPath, csvContent)
    console.log(`Generated monthly sponsorship CSV: ${csvPath}`)
  }

  /**
   * Formats CSV content with contributor data
   */
  private formatCSV(
    data: Record<string, ContributorStats>,
    monthName: string,
    year: number,
  ): { csvContent: string; fileName: string } {
    const fileName = `sponsorships-${year}-${monthName}.csv`
    const header = "Contributor,Amount,Remarks,Snapshot Date,Month\n"

    const rows = Object.entries(data).map(([contributor, stats]) => {
      const { amount, breakdown } = this.calculateAmount(stats)
      return [
        contributor,
        amount.toFixed(2),
        `"${breakdown}"`,
        new Date().toISOString().split("T")[0],
        monthName,
      ].join(",")
    })

    return {
      csvContent: header + rows.join("\n"),
      fileName,
    }
  }

  /**
   * Calculates sponsorship amount and breakdown remarks
   */
  private calculateAmount(stats: ContributorStats): {
    amount: number
    breakdown: string
  } {
    const safeStats = this.sanitizeStats(stats)
    const stars = safeStats.stars || ""
    const score = safeStats.score || 0

    // Calculate base sponsorship tier
    let amount = 0
    let breakdown = []

    // Star-based sponsorship tiers
    if (stars.includes("👑")) {
      amount = 400
      breakdown.push("3 star (👑) sponsorship")
    } else {
      const starCount = (stars.match(/⭐/g) || []).length
      switch (starCount) {
        case 1:
          amount = 50
          breakdown.push("1 star (⭐) sponsorship")
          break
        case 2:
          amount = 150
          breakdown.push("2 star (⭐⭐) sponsorship")
          break
        case 3:
          amount = 400
          breakdown.push("3 star (⭐⭐⭐) sponsorship")
          break
        default:
          if (score > 3) {
            amount = this.config.baseRate! // Use baseRate for contributors with score > 3
            breakdown.push(
              `Base sponsorship (score > 3): $${this.config.baseRate}`,
            )
          } else {
            breakdown.push("No star rating or qualifying score")
          }
      }
    }

    // Add issue rewards
    const issueAmount = Math.min(
      safeStats.issuesCreated || 0,
      this.config.issueCap!,
    )
    if (issueAmount > 0) {
      amount += issueAmount * this.config.issueConversionRate!
      breakdown.push(
        `Issues Created: ${issueAmount} (${this.config.issueConversionRate}pts/issue)`,
      )
    }

    // Weekly contribution requirement check
    const weeklyRequirementMet =
      safeStats.major! >= 5 ||
      safeStats.minor! >= 12 ||
      safeStats.prsMerged >= 8

    if (!weeklyRequirementMet) {
      amount = 0
      breakdown.push("Weekly contribution requirement not met")
    }

    return {
      amount,
      breakdown: breakdown.join(" | ") || "No qualifying contributions",
    }
  }

  /**
   * Aggregates data from all JSON files in the current month
   */
  private aggregateMonthlyData(
    currentDate: Date,
  ): Record<string, ContributorStats> {
    const monthlyData: Record<string, ContributorStats> = {}
    const jsonDir = path.join(__dirname, "../contribution-overviews")

    if (!fs.existsSync(jsonDir)) return monthlyData

    // Get all JSON files for the current month
    const monthStart = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth(),
      1,
    )

    fs.readdirSync(jsonDir)
      .filter((file) => {
        if (!file.endsWith(".json")) return false
        try {
          const fileDate = this.parseDateFromFilename(file)
          return fileDate >= monthStart && fileDate <= currentDate
        } catch {
          return false
        }
      })
      .forEach((file) => {
        const filePath = path.join(jsonDir, file)
        try {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<
            string,
            ContributorStats
          >
          this.mergeContributorData(monthlyData, data)
        } catch (error) {
          console.error(`Error processing ${file}:`, error)
        }
      })

    return monthlyData
  }

  /**
   * Merges contributor data from multiple JSON files
   */
  private mergeContributorData(
    accumulator: Record<string, ContributorStats>,
    currentData: Record<string, ContributorStats>,
  ): void {
    Object.entries(currentData).forEach(([contributor, stats]) => {
      if (!accumulator[contributor]) {
        accumulator[contributor] = this.initializeStats()
      }

      // Safely handle numeric values with defaults
      const safeStats = this.sanitizeStats(stats)

      // Sum PR impacts with nullish coalescing
      accumulator[contributor].major = this.sumWithDefault(
        accumulator[contributor].major,
        safeStats.major,
      )
      accumulator[contributor].minor = this.sumWithDefault(
        accumulator[contributor].minor,
        safeStats.minor,
      )
      accumulator[contributor].tiny = this.sumWithDefault(
        accumulator[contributor].tiny,
        safeStats.tiny,
      )

      // Sum issues created
      accumulator[contributor].issuesCreated = this.sumWithDefault(
        accumulator[contributor].issuesCreated,
        safeStats.issuesCreated,
      )

      // Sum PRs merged
      accumulator[contributor].prsMerged = this.sumWithDefault(
        accumulator[contributor].prsMerged,
        safeStats.prsMerged,
      )

      // Use the highest star rating for the month
      if (safeStats.stars) {
        const currentStars = accumulator[contributor].stars || ""
        if (
          this.getStarValue(safeStats.stars) > this.getStarValue(currentStars)
        ) {
          accumulator[contributor].stars = safeStats.stars
        }
      }
    })
  }

  /**
   * Converts star rating to a numeric value for comparison
   */
  private getStarValue(stars: string): number {
    if (stars.includes("👑")) return 4 // 👑 is higher than ⭐⭐⭐
    return (stars.match(/⭐/g) || []).length
  }

  /**
   * Sanitizes stats to ensure numeric fields have defaults
   */
  private sanitizeStats(stats: ContributorStats): ContributorStats {
    return {
      ...stats,
      major: stats.major ?? 0,
      minor: stats.minor ?? 0,
      tiny: stats.tiny ?? 0,
      issuesCreated: stats.issuesCreated ?? 0,
      prsMerged: stats.prsMerged ?? 0,
      score: stats.score ?? 0,
      stars: stats.stars || "",
    }
  }

  /**
   * Sums two numbers with nullish coalescing
   */
  private sumWithDefault(a: number | undefined, b: number | undefined): number {
    return (a ?? 0) + (b ?? 0)
  }

  /**
   * Parses date from filename
   */
  private parseDateFromFilename(filename: string): Date {
    const datePart = filename.split(".")[0]
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
      throw new Error("Invalid filename format")
    }
    return new Date(datePart)
  }

  /**
   * Ensures the directory exists
   */
  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
    }
  }

  /**
   * Initializes contributor stats with defaults
   */
  private initializeStats(): ContributorStats {
    return {
      reviewsReceived: 0,
      rejectionsReceived: 0,
      approvalsReceived: 0,
      prsOpened: 0,
      prsMerged: 0,
      issuesCreated: 0,
      approvalsGiven: 0,
      rejectionsGiven: 0,
      distinctPrsReviewed: 0,
      bountiedIssuesCount: 0,
      bountiedIssuesTotal: 0,
      major: 0,
      minor: 0,
      tiny: 0,
      score: 0,
      stars: "",
    }
  }
}

// CLI Integration
if (import.meta.main) {
  new SponsorshipCalculator(DEFAULT_CONFIG).generateMonthlyCSV()
}
