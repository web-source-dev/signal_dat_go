import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { SessionGuard } from "../auth/session.guard";
import { BrokerInsightsService } from "./broker-insights.service";

@UseGuards(SessionGuard)
@Controller("broker-insights")
export class BrokerInsightsController {
  constructor(private readonly service: BrokerInsightsService) {}

  /**
   * `mc` is preferred when available; `name` is the fallback since load
   * board listing rows rarely surface a carrier's MC number directly (see
   * fmcsa.client.ts's fetchCarrierByName caveats about disambiguation).
   */
  @Get()
  async get(@Query("mc") mc?: string, @Query("name") name?: string, @Query("phone") phone?: string) {
    if (!mc && !name) throw new BadRequestException("mc or name query param is required");
    return this.service.getInsight({ mc, name }, phone);
  }
}
